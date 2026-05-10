import express from "express";
import nodemailer from "nodemailer";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  // Create managers table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS managers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      twilio_number TEXT UNIQUE NOT NULL,
      dashboard_password TEXT NOT NULL,
      plan TEXT DEFAULT 'starter',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Create maintenance contacts table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_contacts (
      id SERIAL PRIMARY KEY,
      manager_id INTEGER REFERENCES managers(id),
      category TEXT NOT NULL,
      name TEXT,
      phone TEXT NOT NULL
    );
  `);

  // Create or update tenants table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      phone TEXT PRIMARY KEY,
      address TEXT,
      opted_in BOOLEAN DEFAULT true,
      opted_in_at TIMESTAMPTZ DEFAULT NOW(),
      opted_out BOOLEAN DEFAULT false,
      manager_id INTEGER REFERENCES managers(id)
    );
  `);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES managers(id)`).catch(() => {});

  // Create or update conversations table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      phone TEXT PRIMARY KEY,
      messages JSONB DEFAULT '[]',
      resolved BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      manager_id INTEGER REFERENCES managers(id)
    );
  `);
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES managers(id)`).catch(() => {});

  // Create or update requests table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id SERIAL PRIMARY KEY,
      tenant_phone TEXT,
      address TEXT,
      summary TEXT,
      urgency TEXT,
      availability TEXT,
      category TEXT,
      status TEXT DEFAULT 'active',
      manager_id INTEGER REFERENCES managers(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES managers(id)`).catch(() => {});

  // Seed Wyatt as first manager
  const existing = await pool.query("SELECT id FROM managers WHERE twilio_number = $1", ["+15139518826"]);
  let wyattId;
  if (existing.rows.length === 0) {
    const res = await pool.query(`
      INSERT INTO managers (name, email, twilio_number, dashboard_password, plan)
      VALUES ($1, $2, $3, $4, $5) RETURNING id
    `, ["Wyatt Morgan", "wyattmorgan@tenant-flow-ai.com", "+15139518826", "Tenaro", "pro"]);
    wyattId = res.rows[0].id;

    // Seed Wyatt's maintenance contacts
    const categories = ["plumbing", "electrical", "hvac", "structural", "pest", "security", "appliances", "general"];
    for (const cat of categories) {
      await pool.query(
        "INSERT INTO maintenance_contacts (manager_id, category, name, phone) VALUES ($1, $2, $3, $4)",
        [wyattId, cat, cat.charAt(0).toUpperCase() + cat.slice(1) + " Team", "+13308106687"]
      );
    }
  } else {
    wyattId = existing.rows[0].id;
  }

  // Migrate existing data to Wyatt
  await pool.query("UPDATE tenants SET manager_id = $1 WHERE manager_id IS NULL", [wyattId]);
  await pool.query("UPDATE conversations SET manager_id = $1 WHERE manager_id IS NULL", [wyattId]);
  await pool.query("UPDATE requests SET manager_id = $1 WHERE manager_id IS NULL", [wyattId]);

  console.log("[DB] Tables ready");
}

// ─────────────────────────────────────────────
// MANAGER FUNCTIONS
// ─────────────────────────────────────────────
async function getManagerByTwilioNumber(number) {
  const res = await pool.query("SELECT * FROM managers WHERE twilio_number = $1", [number]);
  return res.rows[0] || null;
}

async function getManagerById(id) {
  const res = await pool.query("SELECT * FROM managers WHERE id = $1", [id]);
  return res.rows[0] || null;
}

async function getAllManagers() {
  const res = await pool.query("SELECT * FROM managers ORDER BY created_at DESC");
  return res.rows;
}

async function createManager(name, email, twilioNumber, password, plan, maintenancePhone) {
  const res = await pool.query(`
    INSERT INTO managers (name, email, twilio_number, dashboard_password, plan)
    VALUES ($1, $2, $3, $4, $5) RETURNING id
  `, [name, email, twilioNumber, password, plan]);
  const managerId = res.rows[0].id;

  const categories = ["plumbing", "electrical", "hvac", "structural", "pest", "security", "appliances", "general"];
  for (const cat of categories) {
    await pool.query(
      "INSERT INTO maintenance_contacts (manager_id, category, name, phone) VALUES ($1, $2, $3, $4)",
      [managerId, cat, cat.charAt(0).toUpperCase() + cat.slice(1) + " Team", maintenancePhone]
    );
  }
  return managerId;
}

async function getManagerStats(managerId) {
  const res = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'active') as active,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE urgency = 'EMERGENCY') as emergencies
    FROM requests WHERE manager_id = $1
  `, [managerId]);
  return res.rows[0];
}

// ─────────────────────────────────────────────
// MAINTENANCE CONTACT FUNCTIONS
// ─────────────────────────────────────────────
const ISSUE_KEYWORDS = {
  plumbing:   ["leak", "leaking", "pipe", "drain", "toilet", "sink", "faucet", "water heater", "clog", "clogged", "flood", "flooding", "sewage", "water"],
  electrical: ["electric", "electrical", "outlet", "breaker", "power", "light", "lights", "wiring", "spark", "shock", "circuit", "fuse"],
  hvac:       ["heat", "heating", "ac", "air conditioning", "hvac", "furnace", "thermostat", "vent", "ventilation", "cold", "hot", "temperature"],
  structural: ["door", "window", "wall", "floor", "ceiling", "roof", "crack", "hole", "broken", "damage", "structural", "stairs", "railing"],
  pest:       ["bug", "bugs", "pest", "roach", "cockroach", "mouse", "mice", "rat", "rats", "ant", "ants", "spider", "insect", "rodent", "termite"],
  security:   ["lock", "locks", "key", "keys", "entry", "door lock", "deadbolt", "security", "locked out", "break in", "broken lock"],
  appliances: ["stove", "oven", "fridge", "refrigerator", "washer", "dryer", "dishwasher", "microwave", "appliance", "garbage disposal"],
};

async function getMaintenanceContact(managerId, summary) {
  const lower = summary.toLowerCase();
  let category = "general";
  for (const [cat, keywords] of Object.entries(ISSUE_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) { category = cat; break; }
  }
  const res = await pool.query(
    "SELECT * FROM maintenance_contacts WHERE manager_id = $1 AND category = $2",
    [managerId, category]
  );
  if (res.rows[0]) return { category, ...res.rows[0] };
  // Fallback to general
  const fallback = await pool.query(
    "SELECT * FROM maintenance_contacts WHERE manager_id = $1 AND category = 'general'",
    [managerId]
  );
  return { category: "general", ...fallback.rows[0] };
}

async function getAllMaintenancePhones(managerId) {
  const res = await pool.query("SELECT DISTINCT phone FROM maintenance_contacts WHERE manager_id = $1", [managerId]);
  return new Set(res.rows.map(r => r.phone));
}

// ─────────────────────────────────────────────
// TENANT FUNCTIONS
// ─────────────────────────────────────────────
async function getTenant(phone, managerId) {
  const res = await pool.query("SELECT * FROM tenants WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
  return res.rows[0] || null;
}

async function upsertTenant(phone, managerId, data) {
  await pool.query(`
    INSERT INTO tenants (phone, manager_id, address, opted_in, opted_in_at, opted_out)
    VALUES ($1, $2, $3, $4, NOW(), $5)
    ON CONFLICT (phone) DO UPDATE SET
      address = COALESCE($3, tenants.address),
      opted_in = COALESCE($4, tenants.opted_in),
      opted_out = COALESCE($5, tenants.opted_out),
      manager_id = $2
  `, [phone, managerId, data.address || null, data.opted_in ?? true, data.opted_out ?? false]);
}

async function saveAddress(phone, managerId, address) {
  await pool.query("UPDATE tenants SET address = $1 WHERE phone = $2 AND manager_id = $3", [address, phone, managerId]);
  console.log(`[PROFILE SAVED] ${phone} → ${address}`);
}

async function isOptedOut(phone, managerId) {
  const tenant = await getTenant(phone, managerId);
  return tenant?.opted_out === true;
}

async function isFirstTimeTexter(phone, managerId) {
  const tenant = await getTenant(phone, managerId);
  return !tenant;
}

async function recordOptIn(phone, managerId) {
  await upsertTenant(phone, managerId, { opted_in: true, opted_out: false });
  console.log(`[OPT-IN] ${phone}`);
}

async function recordOptOut(phone, managerId) {
  await pool.query("UPDATE tenants SET opted_out = true WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
  console.log(`[OPT-OUT] ${phone}`);
}

async function getTenantByAddress(managerId, addressFragment) {
  const res = await pool.query(
    "SELECT * FROM tenants WHERE manager_id = $1 AND LOWER(address) LIKE $2 AND opted_out = false",
    [managerId, `%${addressFragment.toLowerCase()}%`]
  );
  return res.rows[0] || null;
}

// ─────────────────────────────────────────────
// CONVERSATION FUNCTIONS
// ─────────────────────────────────────────────
async function getConversation(phone, managerId) {
  const res = await pool.query("SELECT * FROM conversations WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
  if (res.rows[0]) return res.rows[0];
  await pool.query("INSERT INTO conversations (phone, manager_id, messages, resolved) VALUES ($1, $2, '[]', false)", [phone, managerId]);
  return { phone, manager_id: managerId, messages: [], resolved: false };
}

async function addMessage(phone, managerId, role, content) {
  await pool.query(`
    UPDATE conversations SET messages = messages || $1::jsonb, updated_at = NOW()
    WHERE phone = $2 AND manager_id = $3
  `, [JSON.stringify([{ role, content }]), phone, managerId]);
}

async function markResolved(phone, managerId) {
  await pool.query("UPDATE conversations SET resolved = true, updated_at = NOW() WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
  setTimeout(async () => {
    await pool.query("UPDATE conversations SET messages = '[]', resolved = false WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
    console.log(`[CONVO RESET] ${phone}`);
  }, 24 * 60 * 60 * 1000);
}

async function isResolved(phone, managerId) {
  const convo = await getConversation(phone, managerId);
  return convo.resolved;
}

async function clearConversation(phone, managerId) {
  await pool.query("UPDATE conversations SET messages = '[]', resolved = false WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
}

// ─────────────────────────────────────────────
// REQUEST FUNCTIONS
// ─────────────────────────────────────────────
async function saveRequest(managerId, tenantPhone, address, summary, urgency, availability, category) {
  const res = await pool.query(`
    INSERT INTO requests (manager_id, tenant_phone, address, summary, urgency, availability, category, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') RETURNING id
  `, [managerId, tenantPhone, address, summary, urgency, availability, category]);
  return res.rows[0].id;
}

async function updateRequestStatus(managerId, address, status) {
  await pool.query(`
    UPDATE requests SET status = $1, updated_at = NOW()
    WHERE manager_id = $2 AND LOWER(address) LIKE $3 AND status = 'active'
  `, [status, managerId, `%${address.toLowerCase()}%`]);
}

async function getRequestsByManager(managerId) {
  const res = await pool.query("SELECT * FROM requests WHERE manager_id = $1 ORDER BY created_at DESC", [managerId]);
  return res.rows;
}

async function markRequestDone(id) {
  await pool.query("UPDATE requests SET status = 'completed', updated_at = NOW() WHERE id = $1", [id]);
}

// ─────────────────────────────────────────────
// COMPLIANCE MESSAGES
// ─────────────────────────────────────────────
const OPT_IN_CONFIRMATION =
  "Welcome to Tenant Flow AI! By texting this number you consent to receive " +
  "conversational SMS messages for maintenance requests, scheduling updates, and " +
  "property management communication. Msg frequency varies. Msg and data rates may " +
  "apply. Reply STOP to opt out at any time or HELP for assistance.";

const HELP_REPLY =
  "Tenant Flow AI Help: Text us to report maintenance issues and we will route " +
  "your request to the right person. Msg and data rates may apply. Reply STOP to " +
  "opt out. Support: wyattmorgan@tenant-flow-ai.com";

const STOP_KEYWORDS  = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "UNSTOP", "YES"]);

// ─────────────────────────────────────────────
// TWILIO REST CLIENT
// ─────────────────────────────────────────────
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

async function sendSms(to, message, fromNumber) {
  const from = fromNumber || TWILIO_PHONE_NUMBER;
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({ To: to, From: from, Body: message });
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await response.json();
  if (!response.ok) console.error("[TWILIO ERROR]", data);
  else console.log(`[SMS SENT] to ${to} from ${from}`);
}

// ─────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com", port: 587, secure: false,
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

transporter.verify(err => {
  if (err) console.error("[EMAIL VERIFY ERROR]", err.message);
  else console.log("[EMAIL READY] Gmail connection verified");
});

async function sendEmail(to, subject, body) {
  try {
    const info = await transporter.sendMail({ from: `"Tenant Flow AI" <${GMAIL_USER}>`, to, subject, text: body });
    console.log(`[EMAIL SENT] to ${to}`);
  } catch (err) {
    console.error("[EMAIL ERROR]", err.message);
  }
}

// ─────────────────────────────────────────────
// NOTIFY MAINTENANCE
// ─────────────────────────────────────────────
async function notifyMaintenance(manager, tenantPhone, summary, urgency, availability, address) {
  const contact = await getMaintenanceContact(manager.id, summary);
  await saveRequest(manager.id, tenantPhone, address, summary, urgency, availability, contact.category);

  const smsMessage =
    `TENANT FLOW AI - NEW JOB\nCategory: ${contact.category.toUpperCase()}\nUrgency: ${urgency}\n` +
    `Property: ${address}\nTenant Phone: ${tenantPhone}\nAvailability: ${availability}\nIssue: ${summary}\n\n` +
    `Reply: Done <address>, Scheduled <address>, On my way <address>, or Unavailable <address>`;

  const emailBody =
    `New Maintenance Job\n\nCategory: ${contact.category.toUpperCase()}\nProperty: ${address}\n` +
    `Tenant Phone: ${tenantPhone}\nUrgency: ${urgency}\nAvailability: ${availability}\n\nIssue:\n${summary}\n\n---\nTenant Flow AI`;

  console.log(`[MAINTENANCE ALERT] Manager: ${manager.name} | ${contact.category} → ${contact.phone}`);
  await Promise.all([
    sendSms(contact.phone, smsMessage, manager.twilio_number),
    sendEmail(manager.email || GMAIL_USER, `[${urgency}] ${contact.category.toUpperCase()} - ${address}`, emailBody),
  ]);
}

// ─────────────────────────────────────────────
// MAINTENANCE REPLY HANDLER
// ─────────────────────────────────────────────
const STATUS_KEYWORDS = {
  done:        ["done", "completed", "complete", "finished", "fixed", "resolved"],
  scheduled:   ["scheduled", "confirmed", "booked", "appointment set"],
  onmyway:     ["on my way", "on the way", "heading over", "coming now", "be there"],
  unavailable: ["unavailable", "cant make it", "can't make it", "rescheduling", "reschedule"],
};

function detectStatusKeyword(body) {
  const lower = body.toLowerCase();
  for (const [status, keywords] of Object.entries(STATUS_KEYWORDS)) {
    if (keywords.some(k => lower.startsWith(k))) return status;
  }
  return null;
}

function extractAddress(body) {
  for (const keywords of Object.values(STATUS_KEYWORDS)) {
    for (const kw of keywords) {
      if (body.toLowerCase().startsWith(kw)) return body.slice(kw.length).trim();
    }
  }
  return body.trim().split(/\s+/).slice(1).join(" ").trim();
}

async function handleMaintenanceReply(manager, from, body) {
  const status = detectStatusKeyword(body);
  if (!status) {
    await sendSms(from, "To update a job, text: Done <address>, Scheduled <address>, On my way <address>, or Unavailable <address>.", manager.twilio_number);
    return;
  }
  const address = extractAddress(body);
  if (!address) {
    await sendSms(from, "Please include the property address. Example: Done 111 Woodlawn Lima Ohio", manager.twilio_number);
    return;
  }
  const tenant = await getTenantByAddress(manager.id, address);
  if (!tenant) {
    await sendSms(from, `Could not find a tenant at "${address}". Please check the address and try again.`, manager.twilio_number);
    return;
  }
  const dbStatus = status === "done" ? "completed" : status === "onmyway" ? "active" : status;
  await updateRequestStatus(manager.id, address, dbStatus);
  let tenantMessage = "";
  if (status === "done") tenantMessage = `Good news! Your maintenance issue at ${tenant.address} has been resolved. Reply if you have any further concerns. Reply STOP to opt out or HELP for assistance.`;
  else if (status === "scheduled") tenantMessage = `Your maintenance appointment at ${tenant.address} has been scheduled. Your technician will contact you to confirm the exact time. Reply STOP to opt out or HELP for assistance.`;
  else if (status === "onmyway") tenantMessage = `Your technician is on the way to ${tenant.address}! Please make sure someone is available. Reply STOP to opt out or HELP for assistance.`;
  else if (status === "unavailable") tenantMessage = `We are working on rescheduling your visit at ${tenant.address}. We will follow up shortly. Reply STOP to opt out or HELP for assistance.`;
  await sendSms(tenant.phone, tenantMessage, manager.twilio_number);
  await sendSms(from, `Got it! Tenant at ${tenant.address} has been notified.`, manager.twilio_number);
}

// ─────────────────────────────────────────────
// CLAUDE AI
// ─────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are Tenant Flow AI, a friendly AI property management assistant that helps tenants submit maintenance requests via SMS.

Your goal is to collect all the information needed to dispatch the right maintenance person in as few messages as possible. Keep messages short since this is SMS.

CONVERSATION FLOW:
1. When a tenant first describes an issue, acknowledge it warmly.
2. If they have not provided their unit address yet, ask for it naturally (e.g. "Got it! What is your unit address so we can send someone out?")
3. Once you have the address, ask about their availability.
4. Once you have the issue, address, and availability — confirm and tell them the right person will reach out shortly.
5. One question per message maximum.

URGENCY LEVELS:
- EMERGENCY: gas leak, flooding, no heat in winter, electrical hazard → dispatch immediately, skip availability question
- URGENT: no hot water, broken lock, major appliance failure → someone will follow up within a few hours
- ROUTINE: minor repairs, cosmetic issues → scheduled within 1-2 business days

WHEN YOU HAVE ENOUGH INFO:
Send a warm confirmation like "You are all set! We are sending a technician your way. They will reach out to you directly at this number to confirm the appointment. Reply STOP to opt out or HELP for assistance."

Then on the very last line write exactly:
RESOLVED|URGENCY:<level>|SUMMARY:<one sentence summary>|AVAILABILITY:<their availability>|ADDRESS:<their address>

Example: RESOLVED|URGENCY:ROUTINE|SUMMARY:Leaking kitchen sink|AVAILABILITY:Tomorrow morning|ADDRESS:324 Warner St Apt 2 Cincinnati OH

For EMERGENCY: RESOLVED|URGENCY:EMERGENCY|SUMMARY:<issue>|AVAILABILITY:ASAP|ADDRESS:<address or Unknown>

Never make up technician names or exact times. Always end visible messages with "Reply STOP to opt out or HELP for assistance."`;

function parseResolution(text) {
  const match = text.match(/RESOLVED\|URGENCY:(\w+)\|SUMMARY:([^|]+)\|AVAILABILITY:([^|]+)\|ADDRESS:(.+)/);
  if (!match) return null;
  return { urgency: match[1].toUpperCase(), summary: match[2].trim(), availability: match[3].trim(), address: match[4].trim() };
}

function stripResolutionLine(text) {
  return text.replace(/\nRESOLVED\|URGENCY:[^\n]+/g, "").trim();
}

async function processWithClaude(manager, tenantPhone, message) {
  try {
    await addMessage(tenantPhone, manager.id, "user", message);
    const convo = await getConversation(tenantPhone, manager.id);
    console.log(`[CLAUDE] Manager: ${manager.name} | Tenant: ${tenantPhone} (${convo.messages.length} msgs)`);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, system: SYSTEM_PROMPT, messages: convo.messages }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("[CLAUDE ERROR]", data);
      await sendSms(tenantPhone, "We received your message and will follow up shortly. Reply STOP to opt out or HELP for assistance.", manager.twilio_number);
      return;
    }
    const rawReply = data.content[0].text;
    const resolution = parseResolution(rawReply);
    const reply = stripResolutionLine(rawReply);
    await addMessage(tenantPhone, manager.id, "assistant", rawReply);
    await sendSms(tenantPhone, reply, manager.twilio_number);
    if (resolution) {
      if (resolution.address && resolution.address !== "Unknown") await saveAddress(tenantPhone, manager.id, resolution.address);
      console.log(`[RESOLVED] ${tenantPhone} | ${resolution.urgency} | ${resolution.summary}`);
      await markResolved(tenantPhone, manager.id);
      await notifyMaintenance(manager, tenantPhone, resolution.summary, resolution.urgency, resolution.availability, resolution.address);
    }
  } catch (err) {
    console.error("[CLAUDE EXCEPTION]", err);
    await sendSms(tenantPhone, "We received your message and will follow up shortly. Reply STOP to opt out or HELP for assistance.", manager.twilio_number);
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function twimlResponse(msg) { return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + msg + '</Message></Response>'; }
function emptyTwiml() { return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'; }
function urgencyColor(u) { return u === "EMERGENCY" ? "#ef4444" : u === "URGENT" ? "#f97316" : "#22c55e"; }
function statusColor(s) { return s === "completed" ? "#22c55e" : s === "scheduled" ? "#3b82f6" : s === "unavailable" ? "#ef4444" : "#f97316"; }
function timeAgo(date) {
  const s = Math.floor((new Date() - new Date(date)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// ─────────────────────────────────────────────
// COOKIE PARSER
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  req.cookies = {};
  const h = req.headers.cookie;
  if (h) h.split(";").forEach(c => { const [k, v] = c.trim().split("="); req.cookies[k] = v; });
  next();
});

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  console.log("[" + new Date().toISOString() + "] " + req.method + " " + req.path);
  next();
});

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "F@tboyPenny2005";

function checkAdminAuth(req, res, next) {
  if (req.cookies?.admin_auth === ADMIN_PASSWORD) return next();
  res.redirect("/admin/login");
}

async function checkManagerAuth(req, res, next) {
  const managerId = req.cookies?.manager_id;
  const managerPass = req.cookies?.manager_pass;
  if (!managerId) return res.redirect("/dashboard/login");
  const manager = await getManagerById(parseInt(managerId));
  if (!manager || manager.dashboard_password !== managerPass) return res.redirect("/dashboard/login");
  req.manager = manager;
  next();
}

// ─────────────────────────────────────────────
// ADMIN LOGIN
// ─────────────────────────────────────────────
app.get("/admin/login", (req, res) => {
  const error = req.query.error ? '<p style="color:#ef4444;margin-bottom:16px;font-size:14px;">Incorrect password.</p>' : "";
  res.send(`<html><head><title>Admin Login</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;}.card{background:white;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,0.08);}h1{font-size:22px;color:#1e293b;margin-bottom:8px;}p{font-size:14px;color:#64748b;margin-bottom:28px;}label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}input{width:100%;padding:12px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px;outline:none;}button{width:100%;padding:13px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;margin-top:16px;}</style></head><body><div class="card"><h1>Admin Panel</h1><p>Tenant Flow AI — Admin Access</p>${error}<form method="POST" action="/admin/login"><label>Admin Password</label><input type="password" name="password" autofocus><button>Sign In</button></form></div></body></html>`);
});

app.post("/admin/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.setHeader("Set-Cookie", `admin_auth=${ADMIN_PASSWORD}; Path=/; HttpOnly; Max-Age=86400`);
    res.redirect("/admin");
  } else {
    res.redirect("/admin/login?error=1");
  }
});

// ─────────────────────────────────────────────
// ADMIN PANEL
// ─────────────────────────────────────────────
app.get("/admin", checkAdminAuth, async (req, res) => {
  const managers = await getAllManagers();
  const statsPromises = managers.map(m => getManagerStats(m.id));
  const stats = await Promise.all(statsPromises);

  const PLAN_PRICES = { starter: 149, growth: 299, pro: 599 };

  const mrr = managers.reduce((sum, m) => sum + (PLAN_PRICES[m.plan] || 0), 0);
  const arr = mrr * 12;

  function monthsActive(createdAt) {
    const months = Math.floor((new Date() - new Date(createdAt)) / (1000 * 60 * 60 * 24 * 30));
    return Math.max(1, months);
  }

  const clientRows = managers.map((m, i) => `
    <tr>
      <td>${m.name}</td>
      <td>${m.email || "-"}</td>
      <td>${m.twilio_number}</td>
      <td><code style="background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:13px">${m.dashboard_password}</code></td>
      <td>
        <form method="POST" action="/admin/managers/${m.id}/plan" style="display:flex;align-items:center;gap:6px">
          <select name="plan" style="padding:4px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px">
            <option value="starter" ${m.plan === "starter" ? "selected" : ""}>Starter $149</option>
            <option value="growth" ${m.plan === "growth" ? "selected" : ""}>Growth $299</option>
            <option value="pro" ${m.plan === "pro" ? "selected" : ""}>Pro $599</option>
          </select>
          <button type="submit" style="background:#3b82f6;color:white;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold">Save</button>
        </form>
      </td>
      <td>${stats[i].total}</td>
      <td>${stats[i].active}</td>
      <td>${timeAgo(m.created_at)}</td>
      <td>
        <form method="POST" action="/admin/managers/${m.id}/delete" onsubmit="return confirm('Delete ${m.name}? This cannot be undone.')">
          <button type="submit" style="background:#ef4444;color:white;border:none;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold">Delete</button>
        </form>
      </td>
    </tr>
  `).join("");

  const revenueRows = managers.map(m => {
    const monthly = PLAN_PRICES[m.plan] || 0;
    const months = monthsActive(m.created_at);
    const total = monthly * months;
    return `
      <tr>
        <td>${m.name}</td>
        <td><span style="background:#3b82f6;color:#fff;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:bold">${m.plan}</span></td>
        <td style="color:#22c55e;font-weight:bold">$${monthly}/mo</td>
        <td>${new Date(m.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" })}</td>
        <td>${months} month${months !== 1 ? "s" : ""}</td>
        <td style="font-weight:bold">$${total.toLocaleString()}</td>
      </tr>
    `;
  }).join("");

  res.send(`
    <html><head><title>Tenant Flow AI Admin</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;color:#1e293b;}
    .header{background:#1e293b;color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;}
    .header h1{font-size:22px;}.logout{font-size:13px;color:#94a3b8;text-decoration:none;padding:6px 12px;border:1px solid #475569;border-radius:6px;}
    .content{padding:32px;}.section{background:white;border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
    h2{font-size:18px;margin-bottom:20px;}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}
    input,select{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;}
    button{padding:12px 24px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;margin-top:8px;}
    table{width:100%;border-collapse:collapse;}th{text-align:left;padding:12px 16px;font-size:12px;color:#64748b;text-transform:uppercase;border-bottom:1px solid #e2e8f0;}
    td{padding:14px 16px;font-size:14px;border-bottom:1px solid #f1f5f9;}tr:last-child td{border-bottom:none;}tr:hover td{background:#f8fafc;}
    .stat-row{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap;}
    .stat{background:white;border-radius:12px;padding:20px 24px;flex:1;min-width:120px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
    .stat .num{font-size:28px;font-weight:bold;}.stat .label{font-size:12px;color:#64748b;margin-top:4px;}
    .mrr-banner{background:linear-gradient(135deg,#1e293b,#334155);color:white;border-radius:12px;padding:28px 32px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;}
    .mrr-banner .big{font-size:48px;font-weight:bold;color:#22c55e;}
    .mrr-banner .sub{font-size:14px;color:#94a3b8;margin-top:4px;}
    .mrr-banner .arr{font-size:22px;font-weight:bold;color:#94a3b8;}
    </style></head><body>
    <div class="header"><h1>Tenant Flow AI — Admin</h1><a href="/admin/logout" class="logout">Sign Out</a></div>
    <div class="content">

      <div class="mrr-banner">
        <div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">Monthly Recurring Revenue</div>
          <div class="big">$${mrr.toLocaleString()}</div>
          <div class="sub">${managers.length} active client${managers.length !== 1 ? "s" : ""}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:13px;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">Annual Run Rate</div>
          <div class="arr">$${arr.toLocaleString()}/yr</div>
        </div>
      </div>

      <div class="stat-row">
        <div class="stat"><div class="num">${managers.length}</div><div class="label">Total Clients</div></div>
        <div class="stat"><div class="num" style="color:#22c55e">$${mrr.toLocaleString()}</div><div class="label">MRR</div></div>
        <div class="stat"><div class="num" style="color:#f97316">${stats.reduce((a,s)=>a+parseInt(s.active),0)}</div><div class="label">Active Requests</div></div>
        <div class="stat"><div class="num" style="color:#3b82f6">${stats.reduce((a,s)=>a+parseInt(s.total),0)}</div><div class="label">Total Requests</div></div>
      </div>

      <div class="section">
        <h2>Revenue Tracker</h2>
        <table>
          <thead><tr><th>Client</th><th>Plan</th><th>Monthly Revenue</th><th>Started</th><th>Months Active</th><th>Total Paid</th></tr></thead>
          <tbody>${revenueRows || '<tr><td colspan="6" style="text-align:center;padding:40px;color:#94a3b8">No clients yet</td></tr>'}</tbody>
        </table>
        <div style="padding:16px;text-align:right;font-size:15px;font-weight:bold;color:#1e293b;border-top:2px solid #e2e8f0;margin-top:8px">
          Total MRR: <span style="color:#22c55e;font-size:20px">$${mrr.toLocaleString()}/mo</span>
        </div>
      </div>

      <div class="section">
        <h2>Add New Client</h2>
        <form method="POST" action="/admin/managers">
          <div class="form-grid">
            <div><label>Manager Name</label><input name="name" placeholder="John Smith" required></div>
            <div><label>Email</label><input name="email" type="email" placeholder="john@company.com"></div>
            <div><label>Twilio Phone Number</label><input name="twilio_number" placeholder="+15551234567" required></div>
            <div><label>Dashboard Password</label><input name="password" placeholder="their login password" required></div>
            <div><label>Maintenance Contact Phone</label><input name="maintenance_phone" placeholder="+15559876543" required></div>
            <div><label>Plan</label><select name="plan"><option value="starter">Starter — $149/mo</option><option value="growth">Growth — $299/mo</option><option value="pro">Pro — $599/mo</option></select></div>
          </div>
          <button type="submit">Add Client</button>
        </form>
      </div>

      <div class="section">
        <h2>All Clients</h2>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Twilio Number</th><th>Dashboard Password</th><th>Plan</th><th>Total Requests</th><th>Active</th><th>Added</th><th>Actions</th></tr></thead>
          <tbody>${clientRows || '<tr><td colspan="9" style="text-align:center;padding:40px;color:#94a3b8">No clients yet</td></tr>'}</tbody>
        </table>
      </div>
    </div></body></html>
  `);
});

app.post("/admin/managers", checkAdminAuth, async (req, res) => {
  const { name, email, twilio_number, password, maintenance_phone, plan } = req.body;
  await createManager(name, email, twilio_number, password, plan, maintenance_phone);
  console.log(`[ADMIN] New manager created: ${name} | ${twilio_number}`);
  res.redirect("/admin");
});

app.post("/admin/managers/:id/plan", checkAdminAuth, async (req, res) => {
  const { plan } = req.body;
  await pool.query("UPDATE managers SET plan = $1 WHERE id = $2", [plan, req.params.id]);
  console.log(`[ADMIN] Plan updated for manager ${req.params.id} → ${plan}`);
  res.redirect("/admin");
});

app.post("/admin/managers/:id/delete", checkAdminAuth, async (req, res) => {
  const id = req.params.id;
  // Delete in correct order to avoid foreign key violations
  await pool.query("DELETE FROM maintenance_contacts WHERE manager_id = $1", [id]);
  await pool.query("DELETE FROM requests WHERE manager_id = $1", [id]);
  await pool.query("DELETE FROM conversations WHERE manager_id = $1", [id]);
  await pool.query("DELETE FROM tenants WHERE manager_id = $1", [id]);
  await pool.query("DELETE FROM managers WHERE id = $1", [id]);
  console.log(`[ADMIN] Manager ${id} deleted`);
  res.redirect("/admin");
});

app.get("/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "admin_auth=; Path=/; HttpOnly; Max-Age=0");
  res.redirect("/admin/login");
});

// ─────────────────────────────────────────────
// MANAGER DASHBOARD LOGIN
// ─────────────────────────────────────────────
app.get("/dashboard/login", (req, res) => {
  const error = req.query.error ? '<p style="color:#ef4444;margin-bottom:16px;font-size:14px;">Incorrect password.</p>' : "";
  res.send(`<html><head><title>Dashboard Login</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;}.card{background:white;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,0.08);}h1{font-size:22px;color:#1e293b;margin-bottom:8px;}p.sub{font-size:14px;color:#64748b;margin-bottom:28px;}label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}input{width:100%;padding:12px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px;outline:none;margin-bottom:16px;}button{width:100%;padding:13px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;}</style></head><body><div class="card"><h1>Tenant Flow AI</h1><p class="sub">Sign in to your dashboard</p>${error}<form method="POST" action="/dashboard/login"><label>Phone Number (your Twilio number)</label><input name="twilio_number" placeholder="+15139518826"><label>Password</label><input type="password" name="password" autofocus><button>Sign In</button></form></div></body></html>`);
});

app.post("/dashboard/login", async (req, res) => {
  const { twilio_number, password } = req.body;
  const manager = await getManagerByTwilioNumber(twilio_number);
  if (manager && manager.dashboard_password === password) {
    res.setHeader("Set-Cookie", [
      `manager_id=${manager.id}; Path=/; HttpOnly; Max-Age=86400`,
      `manager_pass=${password}; Path=/; HttpOnly; Max-Age=86400`
    ]);
    res.redirect("/dashboard");
  } else {
    res.redirect("/dashboard/login?error=1");
  }
});

// ─────────────────────────────────────────────
// MANAGER DASHBOARD
// ─────────────────────────────────────────────
app.get("/dashboard", checkManagerAuth, async (req, res) => {
  const manager = req.manager;
  const filter = req.query.filter || "all";
  let requests = await getRequestsByManager(manager.id);

  const total     = requests.length;
  const active    = requests.filter(r => r.status === "active").length;
  const completed = requests.filter(r => r.status === "completed").length;
  const emergency = requests.filter(r => r.urgency === "EMERGENCY").length;

  if (filter === "active") requests = requests.filter(r => r.status === "active");
  if (filter === "completed") requests = requests.filter(r => r.status === "completed");
  if (filter === "scheduled") requests = requests.filter(r => r.status === "scheduled");

  const rows = requests.map(r => `
    <tr>
      <td>${timeAgo(r.created_at)}</td>
      <td>${r.address || "Unknown"}</td>
      <td>${r.tenant_phone}</td>
      <td><span style="background:${urgencyColor(r.urgency)};color:#fff;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:bold">${r.urgency}</span></td>
      <td>${r.category}</td>
      <td>${r.summary}</td>
      <td>${r.availability}</td>
      <td><span style="background:${statusColor(r.status)};color:#fff;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:bold">${r.status}</span></td>
      <td>${r.status !== "completed" ? `<form method="POST" action="/dashboard/complete/${r.id}" style="display:inline"><button type="submit" style="background:#22c55e;color:white;border:none;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold">Mark Done</button></form>` : ""}</td>
    </tr>
  `).join("");

  res.send(`
    <html><head><title>${manager.name} — Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;color:#1e293b;}
    .header{background:#1e293b;color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;}
    .header h1{font-size:20px;}.header-right{display:flex;align-items:center;gap:16px;}
    .header-right span{font-size:13px;color:#94a3b8;}.logout{font-size:13px;color:#94a3b8;text-decoration:none;padding:6px 12px;border:1px solid #475569;border-radius:6px;}
    .stats{display:flex;gap:16px;padding:24px 32px;flex-wrap:wrap;}
    .stat{background:white;border-radius:12px;padding:20px 24px;flex:1;min-width:140px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
    .stat .num{font-size:32px;font-weight:bold;}.stat .label{font-size:13px;color:#64748b;margin-top:4px;}
    .filters{padding:0 32px 16px;display:flex;gap:8px;flex-wrap:wrap;}
    .filters a{padding:8px 16px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:bold;background:white;color:#64748b;}
    .filters a.active{background:#1e293b;color:white;}
    .table-wrap{padding:0 32px 32px;overflow-x:auto;}
    table{width:100%;border-collapse:collapse;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
    th{background:#f8fafc;text-align:left;padding:12px 16px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;}
    td{padding:14px 16px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}
    tr:last-child td{border-bottom:none;}tr:hover td{background:#f8fafc;}
    .empty{text-align:center;padding:60px;color:#94a3b8;font-size:16px;}
    </style><meta http-equiv="refresh" content="30"></head><body>
    <div class="header">
      <h1>Tenant Flow AI — ${manager.name}</h1>
      <div class="header-right"><span>Auto-refreshes every 30s</span><a href="/dashboard/logout" class="logout">Sign Out</a></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="num">${total}</div><div class="label">Total Requests</div></div>
      <div class="stat"><div class="num" style="color:#f97316">${active}</div><div class="label">Active</div></div>
      <div class="stat"><div class="num" style="color:#22c55e">${completed}</div><div class="label">Completed</div></div>
      <div class="stat"><div class="num" style="color:#ef4444">${emergency}</div><div class="label">Emergencies</div></div>
    </div>
    <div class="filters">
      <a href="/dashboard?filter=all" class="${filter==="all"?"active":""}">All</a>
      <a href="/dashboard?filter=active" class="${filter==="active"?"active":""}">Active</a>
      <a href="/dashboard?filter=completed" class="${filter==="completed"?"active":""}">Completed</a>
      <a href="/dashboard?filter=scheduled" class="${filter==="scheduled"?"active":""}">Scheduled</a>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Time</th><th>Property</th><th>Tenant</th><th>Urgency</th><th>Category</th><th>Issue</th><th>Availability</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="empty">No requests found</td></tr>'}</tbody>
    </table></div></body></html>
  `);
});

app.post("/dashboard/complete/:id", checkManagerAuth, async (req, res) => {
  await markRequestDone(req.params.id);
  res.redirect("/dashboard");
});

app.get("/dashboard/logout", (req, res) => {
  res.setHeader("Set-Cookie", ["manager_id=; Path=/; HttpOnly; Max-Age=0", "manager_pass=; Path=/; HttpOnly; Max-Age=0"]);
  res.redirect("/dashboard/login");
});

// ─────────────────────────────────────────────
// HOMEPAGE
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.status(200).send(
    '<html><head><title>Tenant Flow AI</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;text-align:center;padding:60px;color:#333;}h1{font-size:42px;margin-bottom:10px;}p{font-size:18px;max-width:900px;margin:12px auto;line-height:1.6;}.section-title{font-weight:bold;margin-top:30px;font-size:20px;}.owner{margin-top:25px;font-weight:bold;}.contact{margin-top:20px;font-weight:bold;}.links{margin-top:25px;}.links a{margin:0 10px;color:#2563eb;text-decoration:none;font-weight:bold;}footer{margin-top:60px;font-size:14px;color:#777;}</style></head><body>' +
    '<h1>Tenant Flow AI</h1><p>AI-powered tenant maintenance communication platform for property managers.</p>' +
    '<p>Tenants can report maintenance issues via SMS. The system collects all details and automatically dispatches the right maintenance person.</p>' +
    '<p class="section-title">How It Works</p>' +
    '<p>Tenants text their issue. Tenant Flow AI collects the issue details, unit address, and availability — then contacts the right maintenance person directly.</p>' +
    '<p class="section-title">How to Get Started</p>' +
    '<p>Text the Tenant Flow AI phone number to report a maintenance issue. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p>' +
    '<p class="section-title">SMS Consent and Compliance</p>' +
    '<p>Users opt in by initiating contact via text message. No marketing messages are sent through this program.</p>' +
    '<p class="owner">Tenant Flow AI is owned and operated by Wyatt D Morgan.</p>' +
    '<p>Business Location: United States</p><p>Service Type: Property Management Communication Software</p>' +
    '<p class="contact">Contact: wyattmorgan@tenant-flow-ai.com</p>' +
    '<div class="links"><a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms and Conditions</a> | <a href="/dashboard">Dashboard</a></div>' +
    '<footer>&copy; 2026 Tenant Flow AI</footer></body></html>'
  );
});

// ─────────────────────────────────────────────
// SMS ENDPOINT
// ─────────────────────────────────────────────
app.get("/sms", (req, res) => res.status(200).send("SMS endpoint alive. Twilio must POST here."));

app.post("/sms", async (req, res) => {
  const from    = req.body.From || "";
  const to      = req.body.To || TWILIO_PHONE_NUMBER;
  const body    = (req.body.Body || "").trim();
  const keyword = body.toUpperCase();

  console.log(`Incoming SMS | From: ${from} | To: ${to} | Message: ${body}`);

  // Look up which manager this number belongs to
  const manager = await getManagerByTwilioNumber(to);
  if (!manager) {
    console.error(`[ERROR] No manager found for Twilio number: ${to}`);
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  if (STOP_KEYWORDS.has(keyword)) {
    await recordOptOut(from, manager.id);
    await clearConversation(from, manager.id);
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }
  if (START_KEYWORDS.has(keyword)) {
    await recordOptIn(from, manager.id);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }
  if (keyword === "HELP") {
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(HELP_REPLY));
  }

  // Check if this is a maintenance person replying
  const maintenancePhones = await getAllMaintenancePhones(manager.id);
  if (maintenancePhones.has(from)) {
    res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
    await handleMaintenanceReply(manager, from, body);
    return;
  }

  if (await isOptedOut(from, manager.id)) return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());

  if (await isFirstTimeTexter(from, manager.id)) {
    await recordOptIn(from, manager.id);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  if (await isResolved(from, manager.id)) await clearConversation(from, manager.id);

  res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  processWithClaude(manager, from, body);
});

// ─────────────────────────────────────────────
// PRIVACY & TERMS
// ─────────────────────────────────────────────
app.get("/privacy", (req, res) => {
  res.status(200).send('<html><head><title>Privacy Policy</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;padding:40px;color:#333;max-width:900px;margin:auto;line-height:1.7;}h1{font-size:36px;margin-bottom:20px;}h2{font-size:24px;margin-top:30px;}p{font-size:18px;margin-bottom:15px;}</style></head><body><h1>Privacy Policy</h1><p>Tenant Flow AI collects phone numbers, addresses, and message content to facilitate communication between tenants and maintenance personnel.</p><h2>Information We Collect</h2><p>We collect phone numbers, unit addresses, message content, maintenance issue details, and communication history.</p><h2>How We Use Information</h2><p>We use this information solely for service-related communication including maintenance requests, scheduling updates, and property management communication.</p><h2>Information Sharing</h2><p>Tenant Flow AI does not sell or share personal information with third parties for marketing purposes. Mobile numbers are never sold or shared.</p><h2>SMS Messaging and Opt-In</h2><p>Users opt in by sending the first text message to Tenant Flow AI. Upon first contact, users automatically receive a confirmation message. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p><h2>Opt-Out</h2><p>Users may opt out at any time by replying STOP.</p><h2>Contact</h2><p>wyattmorgan@tenant-flow-ai.com</p></body></html>');
});

app.get("/terms", (req, res) => {
  res.status(200).send('<html><head><title>Terms and Conditions</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;padding:40px;color:#333;max-width:900px;margin:auto;line-height:1.7;}h1{font-size:36px;margin-bottom:20px;}h2{font-size:24px;margin-top:30px;}p{font-size:18px;margin-bottom:15px;}</style></head><body><h1>Terms and Conditions</h1><p>These Terms govern the use of Tenant Flow AI messaging services.</p><h2>Program Description</h2><p>Tenant Flow AI provides SMS-based communication for maintenance requests, scheduling, and property management communication.</p><h2>Consent to Receive Messages</h2><p>Users consent by sending the first text message. Upon first contact, users receive an opt-in confirmation recorded with a timestamp.</p><h2>Message Frequency</h2><p>Message frequency varies depending on maintenance activity.</p><h2>Fees</h2><p>Message and data rates may apply.</p><h2>Opt-Out</h2><p>Reply STOP at any time.</p><h2>Help</h2><p>Reply HELP for assistance.</p><h2>Support</h2><p>wyattmorgan@tenant-flow-ai.com</p></body></html>');
});

// ─────────────────────────────────────────────
// 404
// ─────────────────────────────────────────────
app.use((req, res) => res.status(404).send("Not Found: " + req.method + " " + req.path));

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(port, () => console.log("Server running on port " + port));
}).catch(err => {
  console.error("[DB INIT ERROR]", err);
  process.exit(1);
});
