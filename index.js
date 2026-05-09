import express from "express";
import nodemailer from "nodemailer";

const app = express();
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────────
// TENANT PROFILES
// Stores address + manager info per tenant phone
// Tenants only enter their address once ever
// ─────────────────────────────────────────────
const tenantProfiles = new Map(); // phone → { address, managerName, managerPhone, managerEmail }

// Default manager for all tenants (update as needed)
const DEFAULT_MANAGER = {
  managerName: "Wyatt Morgan",
  managerPhone: "+14192964656",
  managerEmail: "Morgaw23@gmail.com",
};

function hasAddress(phone) {
  return tenantProfiles.has(phone) && tenantProfiles.get(phone).address;
}

function saveAddress(phone, address) {
  tenantProfiles.set(phone, { ...DEFAULT_MANAGER, address });
  console.log(`[PROFILE SAVED] ${phone} → ${address}`);
}

function getProfile(phone) {
  return tenantProfiles.get(phone) || { ...DEFAULT_MANAGER, address: "Unknown Property" };
}

// ─────────────────────────────────────────────
// CONVERSATION MEMORY
// ─────────────────────────────────────────────
const conversations = new Map(); // phone → { messages: [], resolved: bool, awaitingAddress: bool }

function getConversation(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, { messages: [], resolved: false, awaitingAddress: false });
  }
  return conversations.get(phone);
}

function addMessage(phone, role, content) {
  getConversation(phone).messages.push({ role, content });
}

function markResolved(phone) {
  getConversation(phone).resolved = true;
  setTimeout(() => {
    conversations.delete(phone);
    console.log(`[CONVO RESET] ${phone} cleared after 24hrs`);
  }, 24 * 60 * 60 * 1000);
}

function isResolved(phone) {
  return getConversation(phone).resolved;
}

// ─────────────────────────────────────────────
// OPT-IN STORE
// ─────────────────────────────────────────────
const optedInUsers = new Map();

function isFirstTimeTexter(phone) {
  return !optedInUsers.has(phone);
}

function isOptedOut(phone) {
  return optedInUsers.get(phone)?.optedOut === true;
}

function recordOptIn(phone) {
  optedInUsers.set(phone, { timestamp: new Date().toISOString(), optedOut: false });
  console.log(`[OPT-IN] ${phone}`);
}

function recordOptOut(phone) {
  const existing = optedInUsers.get(phone) || {};
  optedInUsers.set(phone, { ...existing, optedOut: true });
  console.log(`[OPT-OUT] ${phone}`);
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
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

async function sendEmail(to, subject, body) {
  try {
    await transporter.sendMail({
      from: `"Tenant Flow AI" <${GMAIL_USER}>`,
      to, subject, text: body,
    });
    console.log(`[EMAIL SENT] to ${to}`);
  } catch (err) {
    console.error("[EMAIL ERROR]", err);
  }
}

// ─────────────────────────────────────────────
// NOTIFY MANAGER
// ─────────────────────────────────────────────
async function notifyManager(tenantPhone, summary, urgency, availability) {
  const profile = getProfile(tenantPhone);

  const smsMessage =
    `TENANT FLOW AI - NEW REQUEST\n` +
    `Property: ${profile.address}\n` +
    `Tenant: ${tenantPhone}\n` +
    `Urgency: ${urgency}\n` +
    `Availability: ${availability}\n` +
    `Issue: ${summary}`;

  const emailBody =
    `New Maintenance Request - Ready to Schedule\n\n` +
    `Property: ${profile.address}\n` +
    `Tenant Phone: ${tenantPhone}\n` +
    `Urgency: ${urgency}\n` +
    `Tenant Availability: ${availability}\n\n` +
    `Issue Summary:\n${summary}\n\n` +
    `Next Step: Contact the tenant to confirm the appointment.\n\n` +
    `---\nTenant Flow AI`;

  await Promise.all([
    sendSms(profile.managerPhone, smsMessage),
    sendEmail(profile.managerEmail, `[${urgency}] New Request - ${profile.address}`, emailBody),
  ]);
}

// ─────────────────────────────────────────────
// CLAUDE AI — MAINTENANCE REQUEST FLOW
// ─────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are Tenant Flow AI, a friendly property management assistant that helps tenants submit maintenance requests via SMS.

Your goal is to collect all the information needed to schedule a repair in as few messages as possible (ideally 2-3 exchanges). Keep messages short since this is SMS.

CONVERSATION FLOW:
1. When a tenant first describes an issue, acknowledge it and ask ONLY their availability.
2. Once you have the issue AND availability, confirm and tell them they are all set.
3. One question per message maximum.

URGENCY LEVELS:
- EMERGENCY: gas leak, flooding, no heat in winter, electrical hazard → alert immediately, skip availability question
- URGENT: no hot water, broken lock, major appliance failure → follow up within a few hours
- ROUTINE: minor repairs, cosmetic issues → scheduled within 1-2 business days

WHEN YOU HAVE ENOUGH INFO (issue + availability):
Send a warm confirmation then on the very last line write exactly:
RESOLVED|URGENCY:<level>|SUMMARY:<one sentence summary>|AVAILABILITY:<their availability>

Example last line: RESOLVED|URGENCY:ROUTINE|SUMMARY:Leaking kitchen sink|AVAILABILITY:Tomorrow morning

For EMERGENCY skip availability and use: RESOLVED|URGENCY:EMERGENCY|SUMMARY:<issue>|AVAILABILITY:ASAP

Never make up technician names or exact times. Always end visible messages with "Reply STOP to opt out or HELP for assistance."`;

function parseResolution(text) {
  const match = text.match(/RESOLVED\|URGENCY:(\w+)\|SUMMARY:([^|]+)\|AVAILABILITY:(.+)/);
  if (!match) return null;
  return {
    urgency: match[1].toUpperCase(),
    summary: match[2].trim(),
    availability: match[3].trim(),
  };
}

function stripResolutionLine(text) {
  return text.replace(/\nRESOLVED\|URGENCY:[^\n]+/g, "").trim();
}

async function processWithClaude(tenantPhone, message) {
  try {
    addMessage(tenantPhone, "user", message);
    const convo = getConversation(tenantPhone);

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

    addMessage(tenantPhone, "assistant", rawReply);
    await sendSms(tenantPhone, reply);

    if (resolution) {
      console.log(`[RESOLVED] ${tenantPhone} | ${resolution.urgency} | ${resolution.summary}`);
      markResolved(tenantPhone);
      await notifyManager(tenantPhone, resolution.summary, resolution.urgency, resolution.availability);
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
    '<p>Tenants can report maintenance issues via SMS. The system collects all details, schedules repairs, and notifies property management automatically.</p>' +
    '<p class="section-title">How It Works</p>' +
    '<p>Tenants text their issue. Tenant Flow AI collects their address (once, saved forever), the issue details, and their availability — then alerts the property manager with everything needed to schedule the repair.</p>' +
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

app.post("/sms", (req, res) => {
  const from    = req.body.From || "";
  const body    = (req.body.Body || "").trim();
  const keyword = body.toUpperCase();

  console.log("Incoming SMS from:", from, "| Message:", body);

  // 1. STOP
  if (STOP_KEYWORDS.has(keyword)) {
    recordOptOut(from);
    conversations.delete(from);
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  // 2. START / UNSTOP
  if (START_KEYWORDS.has(keyword)) {
    recordOptIn(from);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  // 3. HELP
  if (keyword === "HELP") {
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(HELP_REPLY));
  }

  // 4. Opted-out
  if (isOptedOut(from)) {
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  // 5. First-time texter — send opt-in confirmation
  if (isFirstTimeTexter(from)) {
    recordOptIn(from);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  // 6. No address on file yet — ask for it
  if (!hasAddress(from)) {
    const convo = getConversation(from);

    if (!convo.awaitingAddress) {
      // First message after opt-in — ask for address
      convo.awaitingAddress = true;
      return res.status(200).set("Content-Type", "text/xml").send(
        twimlResponse(
          "Thanks for reaching out! Before we get started, what is your unit address? " +
          "(Example: 324 Warner St, Apt 2, Cincinnati OH 45219)"
        )
      );
    } else {
      // They just replied with their address — save it
      saveAddress(from, body);
      convo.awaitingAddress = false;
      return res.status(200).set("Content-Type", "text/xml").send(
        twimlResponse(
          `Got it! We have your address on file as: ${body}. ` +
          "You will never need to enter it again. Now, what maintenance issue can we help you with today?"
        )
      );
    }
  }

  // 7. Already resolved — start fresh request
  if (isResolved(from)) {
    conversations.delete(from);
  }

  // 8. Process maintenance request with Claude
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
    '<p>Tenant Flow AI collects phone numbers, addresses, and message content to facilitate communication between tenants, property managers, and maintenance personnel.</p>' +
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
    '<p>Users consent by sending the first text message. Upon first contact, users receive an opt-in confirmation. Opt-in is recorded with a timestamp.</p>' +
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
