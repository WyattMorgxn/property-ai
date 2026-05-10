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
  `);
  console.log("[DB] Tables ready");
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
  await pool.query(
    "UPDATE tenants SET address = $1 WHERE phone = $2",
    [address, phone]
  );
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
  await pool.query(
    "UPDATE tenants SET opted_out = true WHERE phone = $1",
    [phone]
  );
  console.log(`[OPT-OUT] ${phone}`);
}

// Conversation functions
async function getConversation(phone) {
  const res = await pool.query(
    "SELECT * FROM conversations WHERE phone = $1",
    [phone]
  );
  if (res.rows[0]) return res.rows[0];
  await pool.query(
    "INSERT INTO conversations (phone, messages, resolved) VALUES ($1, '[]', false)",
    [phone]
  );
  return { phone, messages: [], resolved: false };
}

async function addMessage(phone, role, content) {
  await pool.query(`
    UPDATE conversations
    SET messages = messages || $1::jsonb, updated_at = NOW()
    WHERE phone = $2
  `, [JSON.stringify([{ role, content }]), phone]);
}

async function markResolved(phone) {
  await pool.query(
    "UPDATE conversations SET resolved = true, updated_at = NOW() WHERE phone = $1",
    [phone]
  );
  // Reset after 24 hours
  setTimeout(async () => {
    await pool.query(
      "UPDATE conversations SET messages = '[]', resolved = false WHERE phone = $1",
      [phone]
    );
    console.log(`[CONVO RESET] ${phone}`);
  }, 24 * 60 * 60 * 1000);
}

async function isResolved(phone) {
  const convo = await getConversation(phone);
  return convo.resolved;
}

async function clearConversation(phone) {
  await pool.query(
    "UPDATE conversations SET messages = '[]', resolved = false WHERE phone = $1",
    [phone]
  );
}

// ─────────────────────────────────────────────
// MAINTENANCE CONTACTS
// Update phone numbers here when you get real contacts
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

console.log("[EMAIL CONFIG] User:", GMAIL_USER);
console.log("[EMAIL CONFIG] Pass length:", GMAIL_PASS ? GMAIL_PASS.length : "NOT SET");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS,
  },
});

transporter.verify(function (error, success) {
  if (error) {
    console.error("[EMAIL VERIFY ERROR]", error.message);
  } else {
    console.log("[EMAIL READY] Gmail connection verified");
  }
});

async function sendEmail(to, subject, body) {
  try {
    console.log(`[EMAIL ATTEMPTING] to ${to}`);
    const info = await transporter.sendMail({
      from: `"Tenant Flow AI" <${GMAIL_USER}>`,
      to, subject, text: body,
    });
    console.log(`[EMAIL SENT] to ${to} | ID: ${info.messageId}`);
  } catch (err) {
    console.error("[EMAIL ERROR]", err.message);
    console.error("[EMAIL ERROR CODE]", err.code);
  }
}

// ─────────────────────────────────────────────
// NOTIFY MAINTENANCE PERSON
// Routes to the right team based on issue type
// Also sends email summary
// ─────────────────────────────────────────────
async function notifyMaintenance(tenantPhone, summary, urgency, availability, address) {
  const contact = getMaintenanceContact(summary);

  const smsMessage =
    `TENANT FLOW AI - NEW JOB\n` +
    `Category: ${contact.category.toUpperCase()}\n` +
    `Urgency: ${urgency}\n` +
    `Property: ${address}\n` +
    `Tenant Phone: ${tenantPhone}\n` +
    `Availability: ${availability}\n` +
    `Issue: ${summary}\n\n` +
    `Please contact the tenant directly to confirm.`;

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
// CLAUDE AI WITH CONVERSATION MEMORY
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
      await sendSms(tenantPhone,
        "Tenant Flow AI: We received your message and will follow up shortly. " +
        "Reply STOP to opt out or HELP for assistance."
      );
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
      await notifyMaintenance(
        tenantPhone,
        resolution.summary,
        resolution.urgency,
        resolution.availability,
        resolution.address
      );
    }

  } catch (err) {
    console.error("[CLAUDE EXCEPTION]", err);
    await sendSms(tenantPhone,
      "Tenant Flow AI: We received your message and will follow up shortly. " +
      "Reply STOP to opt out or HELP for assistance."
    );
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

// ─────────────────────────────────────────────
// LOGGING MIDDLEWARE
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  console.log("[" + new Date().toISOString() + "] " + req.method + " " + req.path);
  next();
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
    '<div class="links"><a href="/privacy">Privacy Policy</a> | <a href="/terms">Terms and Conditions</a></div>' +
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

  // 1. STOP
  if (STOP_KEYWORDS.has(keyword)) {
    await recordOptOut(from);
    await clearConversation(from);
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  // 2. START / UNSTOP
  if (START_KEYWORDS.has(keyword)) {
    await recordOptIn(from);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  // 3. HELP
  if (keyword === "HELP") {
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(HELP_REPLY));
  }

  // 4. Opted-out
  if (await isOptedOut(from)) {
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  // 5. First-time texter — opt them in and send welcome
  if (await isFirstTimeTexter(from)) {
    await recordOptIn(from);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  // 6. Already resolved — start fresh
  if (await isResolved(from)) {
    await clearConversation(from);
  }

  // 7. Process with Claude
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
    '<h2>Opt-Out</h2>' +
    '<p>Users may opt out at any time by replying STOP.</p>' +
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
