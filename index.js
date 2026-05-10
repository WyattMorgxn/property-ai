import express from "express";
import nodemailer from "nodemailer";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      phone TEXT PRIMARY KEY,
      address TEXT,
      opted_in BOOLEAN DEFAULT true,
      opted_in_at TIMESTAMPTZ DEFAULT NOW(),
      opted_out BOOLEAN DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS conversations (
      phone TEXT PRIMARY KEY,
      messages JSONB DEFAULT '[]',
      resolved BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS requests (
      id SERIAL PRIMARY KEY,
      tenant_phone TEXT,
      address TEXT,
      summary TEXT,
      urgency TEXT,
      availability TEXT,
      category TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("[DB] Tables ready");
}

async function saveRequest(tenantPhone, address, summary, urgency, availability, category) {
  const res = await pool.query(`
    INSERT INTO requests (tenant_phone, address, summary, urgency, availability, category, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'active')
    RETURNING id
  `, [tenantPhone, address, summary, urgency, availability, category]);
  return res.rows[0].id;
}

async function updateRequestStatus(address, status) {
  await pool.query(`
    UPDATE requests SET status = $1, updated_at = NOW()
    WHERE LOWER(address) LIKE $2 AND status = 'active'
  `, [status, `%${address.toLowerCase()}%`]);
}

async function getAllRequests() {
  const res = await pool.query(`
    SELECT * FROM requests ORDER BY created_at DESC
  `);
  return res.rows;
}

// Tenant profile functions
async function getTenant(phone) {
  const res = await pool.query("SELECT * FROM tenants WHERE phone = $1", [phone]);
  return res.rows[0] || null;
}

async function upsertTenant(phone, data) {
  await pool.query(`
    INSERT INTO tenants (phone, address, opted_in, opted_in_at, opted_out)
    VALUES ($1, $2, $3, NOW(), $4)
    ON CONFLICT (phone) DO UPDATE SET
      address = COALESCE($2, tenants.address),
      opted_in = COALESCE($3, tenants.opted_in),
      opted_out = COALESCE($4, tenants.opted_out)
  `, [phone, data.address || null, data.opted_in ?? true, data.opted_out ?? false]);
}

async function hasAddress(phone) {
  const tenant = await getTenant(phone);
  return tenant && tenant.address;
}

async function saveAddress(phone, address) {
  await pool.query("UPDATE tenants SET address = $1 WHERE phone = $2", [address, phone]);
  console.log(`[PROFILE SAVED] ${phone} → ${address}`);
}

async function isOptedOut(phone) {
  const tenant = await getTenant(phone);
  return tenant?.opted_out === true;
}

async function isFirstTimeTexter(phone) {
  const tenant = await getTenant(phone);
  return !tenant;
}

async function recordOptIn(phone) {
  await upsertTenant(phone, { opted_in: true, opted_out: false });
  console.log(`[OPT-IN] ${phone}`);
}

async function recordOptOut(phone) {
  await pool.query("UPDATE tenants SET opted_out = true WHERE phone = $1", [phone]);
  console.log(`[OPT-OUT] ${phone}`);
}

async function getTenantByAddress(addressFragment) {
  const res = await pool.query(
    "SELECT * FROM tenants WHERE LOWER(address) LIKE $1 AND opted_out = false",
    [`%${addressFragment.toLowerCase()}%`]
  );
  return res.rows[0] || null;
}

// Conversation functions
async function getConversation(phone) {
  const res = await pool.query("SELECT * FROM conversations WHERE phone = $1", [phone]);
  if (res.rows[0]) return res.rows[0];
  await pool.query("INSERT INTO conversations (phone, messages, resolved) VALUES ($1, '[]', false)", [phone]);
  return { phone, messages: [], resolved: false };
}

async function addMessage(phone, role, content) {
  await pool.query(`
    UPDATE conversations SET messages = messages || $1::jsonb, updated_at = NOW() WHERE phone = $2
  `, [JSON.stringify([{ role, content }]), phone]);
}

async function markResolved(phone) {
  await pool.query("UPDATE conversations SET resolved = true, updated_at = NOW() WHERE phone = $1", [phone]);
  setTimeout(async () => {
    await pool.query("UPDATE conversations SET messages = '[]', resolved = false WHERE phone = $1", [phone]);
    console.log(`[CONVO RESET] ${phone}`);
  }, 24 * 60 * 60 * 1000);
}

async function isResolved(phone) {
  const convo = await getConversation(phone);
  return convo.resolved;
}

async function clearConversation(phone) {
  await pool.query("UPDATE conversations SET messages = '[]', resolved = false WHERE phone = $1", [phone]);
}

// ─────────────────────────────────────────────
// MAINTENANCE CONTACTS
// ─────────────────────────────────────────────
const MAINTENANCE_CONTACTS = {
  plumbing: {
    name: "Plumbing Team",
    phone: "+13308106687",
    keywords: ["leak", "leaking", "pipe", "drain", "toilet", "sink", "faucet", "water heater", "clog", "clogged", "flood", "flooding", "sewage", "water"],
  },
  electrical: {
    name: "Electrical Team",
    phone: "+13308106687",
    keywords: ["electric", "electrical", "outlet", "breaker", "power", "light", "lights", "wiring", "spark", "shock", "circuit", "fuse"],
  },
  hvac: {
    name: "HVAC Team",
    phone: "+13308106687",
    keywords: ["heat", "heating", "ac", "air conditioning", "hvac", "furnace", "thermostat", "vent", "ventilation", "cold", "hot", "temperature"],
  },
  structural: {
    name: "Structural Team",
    phone: "+13308106687",
    keywords: ["door", "window", "wall", "floor", "ceiling", "roof", "crack", "hole", "broken", "damage", "structural", "stairs", "railing"],
  },
  pest: {
    name: "Pest Control Team",
    phone: "+13308106687",
    keywords: ["bug", "bugs", "pest", "roach", "cockroach", "mouse", "mice", "rat", "rats", "ant", "ants", "spider", "insect", "rodent", "termite"],
  },
  security: {
    name: "Security Team",
    phone: "+13308106687",
    keywords: ["lock", "locks", "key", "keys", "entry", "door lock", "deadbolt", "security", "locked out", "break in", "broken lock"],
  },
  appliances: {
    name: "Appliance Team",
    phone: "+13308106687",
    keywords: ["stove", "oven", "fridge", "refrigerator", "washer", "dryer", "dishwasher", "microwave", "appliance", "garbage disposal"],
  },
  general: {
    name: "General Maintenance",
    phone: "+13308106687",
    keywords: [],
  },
};

const MAINTENANCE_PHONES = new Set(Object.values(MAINTENANCE_CONTACTS).map(c => c.phone));

function getMaintenanceContact(summary) {
  const lowerSummary = summary.toLowerCase();
  for (const [category, contact] of Object.entries(MAINTENANCE_CONTACTS)) {
    if (category === "general") continue;
    if (contact.keywords.some(keyword => lowerSummary.includes(keyword))) {
      return { category, ...contact };
    }
  }
  return { category: "general", ...MAINTENANCE_CONTACTS.general };
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

async function handleMaintenanceReply(from, body) {
  const status = detectStatusKeyword(body);

  if (!status) {
    await sendSms(from,
      "Tenant Flow AI: To update a job, text: Done <address>, Scheduled <address>, On my way <address>, or Unavailable <address>."
    );
    return;
  }

  const address = extractAddress(body);
  if (!address) {
    await sendSms(from, "Please include the property address. Example: Done 111 Woodlawn Lima Ohio");
    return;
  }

  const tenant = await getTenantByAddress(address);
  if (!tenant) {
    await sendSms(from, `Could not find a tenant at "${address}". Please check the address and try again.`);
    return;
  }

  console.log(`[MAINTENANCE REPLY] Status: ${status} | Address: ${address} | Tenant: ${tenant.phone}`);

  // Update request status in database
  const dbStatus = status === "done" ? "completed" : status === "onmyway" ? "active" : status;
  await updateRequestStatus(address, dbStatus);

  let tenantMessage = "";
  if (status === "done") {
    tenantMessage = `Good news! Your maintenance issue at ${tenant.address} has been resolved. Reply if you have any further concerns. Reply STOP to opt out or HELP for assistance.`;
  } else if (status === "scheduled") {
    tenantMessage = `Your maintenance appointment at ${tenant.address} has been scheduled. Your technician will contact you directly to confirm the exact time. Reply STOP to opt out or HELP for assistance.`;
  } else if (status === "onmyway") {
    tenantMessage = `Your technician is on the way to ${tenant.address}! Please make sure someone is available to let them in. Reply STOP to opt out or HELP for assistance.`;
  } else if (status === "unavailable") {
    tenantMessage = `We are working on rescheduling your maintenance visit at ${tenant.address}. We will follow up shortly with a new time. Reply STOP to opt out or HELP for assistance.`;
  }

  await sendSms(tenant.phone, tenantMessage);
  await sendSms(from, `Got it! Tenant at ${tenant.address} has been notified.`);
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

async function sendSms(to, message) {
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({ To: to, From: TWILIO_PHONE_NUMBER, Body: message });
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await response.json();
  if (!response.ok) console.error("[TWILIO ERROR]", data);
  else console.log(`[SMS SENT] to ${to}`);
}

// ─────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

transporter.verify(function (error) {
  if (error) console.error("[EMAIL VERIFY ERROR]", error.message);
  else console.log("[EMAIL READY] Gmail connection verified");
});

async function sendEmail(to, subject, body) {
  try {
    const info = await transporter.sendMail({
      from: `"Tenant Flow AI" <${GMAIL_USER}>`,
      to, subject, text: body,
    });
    console.log(`[EMAIL SENT] to ${to} | ID: ${info.messageId}`);
  } catch (err) {
    console.error("[EMAIL ERROR]", err.message);
  }
}

// ─────────────────────────────────────────────
// NOTIFY MAINTENANCE PERSON
// ─────────────────────────────────────────────
async function notifyMaintenance(tenantPhone, summary, urgency, availability, address) {
  const contact = getMaintenanceContact(summary);

  await saveRequest(tenantPhone, address, summary, urgency, availability, contact.category);

  const smsMessage =
    `TENANT FLOW AI - NEW JOB\n` +
    `Category: ${contact.category.toUpperCase()}\n` +
    `Urgency: ${urgency}\n` +
    `Property: ${address}\n` +
    `Tenant Phone: ${tenantPhone}\n` +
    `Availability: ${availability}\n` +
    `Issue: ${summary}\n\n` +
    `Reply: Done <address>, Scheduled <address>, On my way <address>, or Unavailable <address>`;

  const emailBody =
    `New Maintenance Job - Action Required\n\n` +
    `Category: ${contact.category.toUpperCase()}\n` +
    `Property: ${address}\n` +
    `Tenant Phone: ${tenantPhone}\n` +
    `Urgency: ${urgency}\n` +
    `Tenant Availability: ${availability}\n\n` +
    `Issue:\n${summary}\n\n` +
    `Please contact the tenant directly to confirm the appointment.\n\n` +
    `---\nTenant Flow AI`;

  console.log(`[MAINTENANCE ALERT] Routing to ${contact.name} (${contact.phone}) for ${contact.category}`);

  await Promise.all([
    sendSms(contact.phone, smsMessage),
    sendEmail(GMAIL_USER, `[${urgency}] ${contact.category.toUpperCase()} - ${address}`, emailBody),
  ]);
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
  return {
    urgency: match[1].toUpperCase(),
    summary: match[2].trim(),
    availability: match[3].trim(),
    address: match[4].trim(),
  };
}

function stripResolutionLine(text) {
  return text.replace(/\nRESOLVED\|URGENCY:[^\n]+/g, "").trim();
}

async function processWithClaude(tenantPhone, message) {
  try {
    await addMessage(tenantPhone, "user", message);
    const convo = await getConversation(tenantPhone);
    console.log(`[CLAUDE] ${tenantPhone} (${convo.messages.length} msgs)`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: convo.messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("[CLAUDE ERROR]", data);
      await sendSms(tenantPhone, "Tenant Flow AI: We received your message and will follow up shortly. Reply STOP to opt out or HELP for assistance.");
      return;
    }

    const rawReply   = data.content[0].text;
    const resolution = parseResolution(rawReply);
    const reply      = stripResolutionLine(rawReply);

    await addMessage(tenantPhone, "assistant", rawReply);
    await sendSms(tenantPhone, reply);

    if (resolution) {
      if (resolution.address && resolution.address !== "Unknown") {
        await saveAddress(tenantPhone, resolution.address);
      }
      console.log(`[RESOLVED] ${tenantPhone} | ${resolution.urgency} | ${resolution.summary}`);
      await markResolved(tenantPhone);
      await notifyMaintenance(tenantPhone, resolution.summary, resolution.urgency, resolution.availability, resolution.address);
    }

  } catch (err) {
    console.error("[CLAUDE EXCEPTION]", err);
    await sendSms(tenantPhone, "Tenant Flow AI: We received your message and will follow up shortly. Reply STOP to opt out or HELP for assistance.");
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function twimlResponse(msg) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + msg + '</Message></Response>';
}

function emptyTwiml() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function urgencyColor(urgency) {
  if (urgency === "EMERGENCY") return "#ef4444";
  if (urgency === "URGENT") return "#f97316";
  return "#22c55e";
}

function statusColor(status) {
  if (status === "completed") return "#22c55e";
  if (status === "scheduled") return "#3b82f6";
  if (status === "unavailable") return "#ef4444";
  return "#f97316";
}

function timeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ─────────────────────────────────────────────
// LOGGING MIDDLEWARE
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  console.log("[" + new Date().toISOString() + "] " + req.method + " " + req.path);
  next();
});

// ─────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────
app.get("/dashboard", async (req, res) => {
  const filter = req.query.filter || "all";
  let requests = await getAllRequests();

  if (filter === "active") requests = requests.filter(r => r.status === "active");
  if (filter === "completed") requests = requests.filter(r => r.status === "completed");
  if (filter === "scheduled") requests = requests.filter(r => r.status === "scheduled");

  const total     = requests.length;
  const active    = requests.filter(r => r.status === "active").length;
  const completed = requests.filter(r => r.status === "completed").length;
  const emergency = requests.filter(r => r.urgency === "EMERGENCY").length;

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
    </tr>
  `).join("");

  res.status(200).send(`
    <html>
    <head>
      <title>Tenant Flow AI — Dashboard</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; background: #f1f5f9; color: #1e293b; }
        .header { background: #1e293b; color: white; padding: 20px 32px; display: flex; align-items: center; justify-content: space-between; }
        .header h1 { font-size: 22px; }
        .header span { font-size: 14px; color: #94a3b8; }
        .stats { display: flex; gap: 16px; padding: 24px 32px; flex-wrap: wrap; }
        .stat { background: white; border-radius: 12px; padding: 20px 24px; flex: 1; min-width: 140px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
        .stat .num { font-size: 32px; font-weight: bold; }
        .stat .label { font-size: 13px; color: #64748b; margin-top: 4px; }
        .stat.emergency .num { color: #ef4444; }
        .stat.active .num { color: #f97316; }
        .stat.completed .num { color: #22c55e; }
        .filters { padding: 0 32px 16px; display: flex; gap: 8px; flex-wrap: wrap; }
        .filters a { padding: 8px 16px; border-radius: 20px; text-decoration: none; font-size: 13px; font-weight: bold; background: white; color: #64748b; border: 2px solid transparent; }
        .filters a.active { background: #1e293b; color: white; }
        .table-wrap { padding: 0 32px 32px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
        th { background: #f8fafc; text-align: left; padding: 12px 16px; font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e2e8f0; }
        td { padding: 14px 16px; font-size: 14px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background: #f8fafc; }
        .empty { text-align: center; padding: 60px; color: #94a3b8; font-size: 16px; }
        .refresh { font-size: 13px; color: #94a3b8; }
      </style>
      <meta http-equiv="refresh" content="30">
    </head>
    <body>
      <div class="header">
        <h1>Tenant Flow AI Dashboard</h1>
        <span class="refresh">Auto-refreshes every 30 seconds</span>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="num">${total}</div>
          <div class="label">Total Requests</div>
        </div>
        <div class="stat active">
          <div class="num">${active}</div>
          <div class="label">Active</div>
        </div>
        <div class="stat completed">
          <div class="num">${completed}</div>
          <div class="label">Completed</div>
        </div>
        <div class="stat emergency">
          <div class="num">${emergency}</div>
          <div class="label">Emergencies</div>
        </div>
      </div>

      <div class="filters">
        <a href="/dashboard?filter=all" class="${filter === "all" ? "active" : ""}">All</a>
        <a href="/dashboard?filter=active" class="${filter === "active" ? "active" : ""}">Active</a>
        <a href="/dashboard?filter=completed" class="${filter === "completed" ? "active" : ""}">Completed</a>
        <a href="/dashboard?filter=scheduled" class="${filter === "scheduled" ? "active" : ""}">Scheduled</a>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Property</th>
              <th>Tenant</th>
              <th>Urgency</th>
              <th>Category</th>
              <th>Issue</th>
              <th>Availability</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="8" class="empty">No requests found</td></tr>'}
          </tbody>
        </table>
      </div>
    </body>
    </html>
  `);
});

// ─────────────────────────────────────────────
// HOMEPAGE
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.status(200).send(
    '<html><head><title>Tenant Flow AI</title><style>' +
    'body{font-family:Arial,sans-serif;background:#f5f7fb;text-align:center;padding:60px;color:#333;}' +
    'h1{font-size:42px;margin-bottom:10px;}' +
    'p{font-size:18px;max-width:900px;margin:12px auto;line-height:1.6;}' +
    '.section-title{font-weight:bold;margin-top:30px;font-size:20px;}' +
    '.owner{margin-top:25px;font-weight:bold;}' +
    '.contact{margin-top:20px;font-weight:bold;}' +
    '.links{margin-top:25px;}' +
    '.links a{margin:0 10px;color:#2563eb;text-decoration:none;font-weight:bold;}' +
    'footer{margin-top:60px;font-size:14px;color:#777;}' +
    '</style></head><body>' +
    '<h1>Tenant Flow AI</h1>' +
    '<p>AI-powered tenant maintenance communication platform for property managers.</p>' +
    '<p>Tenants can report maintenance issues via SMS. The system collects all details and automatically dispatches the right maintenance person.</p>' +
    '<p class="section-title">How It Works</p>' +
    '<p>Tenants text their issue. Tenant Flow AI collects the issue details, unit address, and availability — then contacts the right maintenance person directly so they can reach out to the tenant to schedule the repair.</p>' +
    '<p class="section-title">How to Get Started</p>' +
    '<p>Text the Tenant Flow AI phone number to report a maintenance issue. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p>' +
    '<p class="section-title">SMS Consent and Compliance</p>' +
    '<p>Users opt in by initiating contact via text message. No marketing messages are sent through this program.</p>' +
    '<p class="owner">Tenant Flow AI is owned and operated by Wyatt D Morgan.</p>' +
    '<p>Business Location: United States</p><p>Service Type: Property Management Communication Software</p>' +
    '<p class="contact">Contact: wyattmorgan@tenant-flow-ai.com</p>' +
    '<div class="links"><a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms and Conditions</a> | <a href="/dashboard">Dashboard</a></div>' +
    '<footer>&copy; 2026 Tenant Flow AI</footer>' +
    '</body></html>'
  );
});

// ─────────────────────────────────────────────
// SMS ENDPOINT
// ─────────────────────────────────────────────
app.get("/sms", (req, res) => {
  res.status(200).send("SMS endpoint alive. Twilio must POST here.");
});

app.post("/sms", async (req, res) => {
  const from    = req.body.From || "";
  const body    = (req.body.Body || "").trim();
  const keyword = body.toUpperCase();

  console.log("Incoming SMS from:", from, "| Message:", body);

  if (STOP_KEYWORDS.has(keyword)) {
    await recordOptOut(from);
    await clearConversation(from);
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  if (START_KEYWORDS.has(keyword)) {
    await recordOptIn(from);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  if (keyword === "HELP") {
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(HELP_REPLY));
  }

  // Check if this is a maintenance person replying
  if (MAINTENANCE_PHONES.has(from)) {
    res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
    await handleMaintenanceReply(from, body);
    return;
  }

  if (await isOptedOut(from)) {
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  if (await isFirstTimeTexter(from)) {
    await recordOptIn(from);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  if (await isResolved(from)) {
    await clearConversation(from);
  }

  res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  processWithClaude(from, body);
});

// ─────────────────────────────────────────────
// PRIVACY POLICY
// ─────────────────────────────────────────────
app.get("/privacy", (req, res) => {
  res.status(200).send(
    '<html><head><title>Privacy Policy</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;padding:40px;color:#333;max-width:900px;margin:auto;line-height:1.7;}h1{font-size:36px;margin-bottom:20px;}h2{font-size:24px;margin-top:30px;}p{font-size:18px;margin-bottom:15px;}</style></head><body>' +
    '<h1>Privacy Policy</h1>' +
    '<p>Tenant Flow AI collects phone numbers, addresses, and message content to facilitate communication between tenants and maintenance personnel.</p>' +
    '<h2>Information We Collect</h2>' +
    '<p>We collect phone numbers, unit addresses, message content, maintenance issue details, and communication history.</p>' +
    '<h2>How We Use Information</h2>' +
    '<p>We use this information solely for service-related communication including maintenance requests, scheduling updates, and property management communication.</p>' +
    '<h2>Information Sharing</h2>' +
    '<p>Tenant Flow AI does not sell or share personal information with third parties for marketing purposes. Mobile numbers are never sold or shared.</p>' +
    '<h2>SMS Messaging and Opt-In</h2>' +
    '<p>Users opt in by sending the first text message to Tenant Flow AI. Upon first contact, users automatically receive a confirmation message. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p>' +
    '<h2>Opt-Out</h2><p>Users may opt out at any time by replying STOP.</p>' +
    '<h2>Contact</h2><p>wyattmorgan@tenant-flow-ai.com</p>' +
    '</body></html>'
  );
});

// ─────────────────────────────────────────────
// TERMS & CONDITIONS
// ─────────────────────────────────────────────
app.get("/terms", (req, res) => {
  res.status(200).send(
    '<html><head><title>Terms and Conditions</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;padding:40px;color:#333;max-width:900px;margin:auto;line-height:1.7;}h1{font-size:36px;margin-bottom:20px;}h2{font-size:24px;margin-top:30px;}p{font-size:18px;margin-bottom:15px;}</style></head><body>' +
    '<h1>Terms and Conditions</h1>' +
    '<p>These Terms govern the use of Tenant Flow AI messaging services.</p>' +
    '<h2>Program Description</h2>' +
    '<p>Tenant Flow AI provides SMS-based communication for maintenance requests, scheduling, and property management communication.</p>' +
    '<h2>Consent to Receive Messages</h2>' +
    '<p>Users consent by sending the first text message. Upon first contact, users receive an opt-in confirmation recorded with a timestamp.</p>' +
    '<h2>Message Frequency</h2><p>Message frequency varies depending on maintenance activity.</p>' +
    '<h2>Fees</h2><p>Message and data rates may apply.</p>' +
    '<h2>Opt-Out</h2><p>Reply STOP at any time.</p>' +
    '<h2>Help</h2><p>Reply HELP for assistance.</p>' +
    '<h2>Support</h2><p>wyattmorgan@tenant-flow-ai.com</p>' +
    '</body></html>'
  );
});

// ─────────────────────────────────────────────
// 404 FALLBACK
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send("Not Found: " + req.method + " " + req.path);
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(port, () => {
    console.log("Server running on port " + port);
  });
}).catch(err => {
  console.error("[DB INIT ERROR]", err);
  process.exit(1);
});
