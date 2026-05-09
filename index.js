import express from "express";
import nodemailer from "nodemailer";

const app = express();
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────────
// PROPERTY LOOKUP TABLE
// ─────────────────────────────────────────────
const PROPERTIES = {
  "+19377033507": {
    address: "324 Warner Street Cincinnati Ohio 45219",
    managerName: "Wyatt Morgan",
    managerPhone: "+14192964656",
    managerEmail: "Morgaw23@gmail.com",
  },
  // Add more tenants here:
  // "+1XXXXXXXXXX": {
  //   address: "123 Main St Cincinnati OH 45000",
  //   managerName: "Wyatt Morgan",
  //   managerPhone: "+14192964656",
  //   managerEmail: "Morgaw23@gmail.com",
  // },
};

const DEFAULT_MANAGER = {
  managerName: "Wyatt Morgan",
  managerPhone: "+14192964656",
  managerEmail: "Morgaw23@gmail.com",
  address: "Unknown Property",
};

function getProperty(tenantPhone) {
  return PROPERTIES[tenantPhone] || { ...DEFAULT_MANAGER };
}

// ─────────────────────────────────────────────
// CONVERSATION MEMORY
// Stores full chat history per tenant so Claude
// remembers the whole back-and-forth
// ─────────────────────────────────────────────
const conversations = new Map(); // phone → { messages: [], resolved: bool }

function getConversation(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, { messages: [], resolved: false });
  }
  return conversations.get(phone);
}

function addMessage(phone, role, content) {
  const convo = getConversation(phone);
  convo.messages.push({ role, content });
}

function markResolved(phone) {
  const convo = getConversation(phone);
  convo.resolved = true;
  // Reset after 24 hours so tenant can submit a new request
  setTimeout(() => {
    conversations.delete(phone);
    console.log(`[CONVO RESET] ${phone} conversation cleared after 24hrs`);
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
  console.log(`[OPT-IN]  ${phone} at ${new Date().toISOString()}`);
}

function recordOptOut(phone) {
  const existing = optedInUsers.get(phone) || {};
  optedInUsers.set(phone, { ...existing, optedOut: true, optOutTimestamp: new Date().toISOString() });
  console.log(`[OPT-OUT] ${phone} at ${new Date().toISOString()}`);
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
    console.log(`[EMAIL SENT] to ${to}: ${subject}`);
  } catch (err) {
    console.error("[EMAIL ERROR]", err);
  }
}

// ─────────────────────────────────────────────
// NOTIFY MANAGER (SMS + Email)
// ─────────────────────────────────────────────
async function notifyManager(tenantPhone, summary, urgency, availability) {
  const property = getProperty(tenantPhone);

  const smsMessage =
    `TENANT FLOW AI - NEW REQUEST\n` +
    `Property: ${property.address}\n` +
    `Tenant: ${tenantPhone}\n` +
    `Urgency: ${urgency}\n` +
    `Availability: ${availability}\n` +
    `Issue: ${summary}`;

  const emailBody =
    `New Maintenance Request - Ready to Schedule\n\n` +
    `Property: ${property.address}\n` +
    `Tenant Phone: ${tenantPhone}\n` +
    `Urgency: ${urgency}\n` +
    `Tenant Availability: ${availability}\n\n` +
    `Issue Summary:\n${summary}\n\n` +
    `Next Step: Contact the tenant to confirm the appointment.\n\n` +
    `---\nTenant Flow AI`;

  const emailSubject = `[${urgency}] New Request - ${property.address}`;

  await Promise.all([
    sendSms(property.managerPhone, smsMessage),
    sendEmail(property.managerEmail, emailSubject, emailBody),
  ]);
}

// ─────────────────────────────────────────────
// CLAUDE AI WITH CONVERSATION MEMORY
// ─────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are Tenant Flow AI, a friendly property management assistant that helps tenants submit maintenance requests via SMS.

Your goal is to collect all the information needed to schedule a repair in as few messages as possible (ideally 2-3 exchanges max). Keep messages short and conversational since this is SMS.

CONVERSATION FLOW:
1. When a tenant first describes an issue, acknowledge it and ask ONLY the most important missing info (usually just their availability).
2. Once you have the issue description AND availability, confirm everything and tell them they are all set.
3. Do NOT ask multiple questions at once. One question per message maximum.

URGENCY LEVELS:
- EMERGENCY: gas leak, flooding, no heat in winter, electrical hazard, fire → tell them you are alerting someone immediately
- URGENT: no hot water, broken lock, major appliance failure → follow up within a few hours
- ROUTINE: minor repairs, cosmetic issues → scheduled within 1-2 business days

WHEN YOU HAVE ENOUGH INFO (issue + availability):
- Send a warm confirmation like "You are all set! We have logged your request and a technician will reach out shortly to confirm your appointment. Reply STOP to opt out or HELP for assistance."
- On the LAST line of your response write exactly: RESOLVED|URGENCY:<level>|SUMMARY:<one sentence summary>|AVAILABILITY:<their availability>
- Example: RESOLVED|URGENCY:ROUTINE|SUMMARY:Leaking kitchen sink|AVAILABILITY:Weekdays after 3pm

For EMERGENCY situations, skip asking about availability and resolve immediately with RESOLVED|URGENCY:EMERGENCY|SUMMARY:<issue>|AVAILABILITY:ASAP

Always be warm, brief, and professional. Never make up technician names or exact times.`;

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
    // Add tenant message to conversation history
    addMessage(tenantPhone, "user", message);

    const convo = getConversation(tenantPhone);

    console.log(`[CLAUDE] Processing from ${tenantPhone} (${convo.messages.length} messages in history)`);

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

    // Save Claude's reply to conversation history
    addMessage(tenantPhone, "assistant", rawReply);

    console.log(`[CLAUDE REPLY] ${reply}`);

    // Send reply to tenant
    await sendSms(tenantPhone, reply);

    // If Claude has collected everything, notify the manager
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
function twimlResponse(message) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + message + '</Message></Response>';
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
    'body { font-family: Arial, sans-serif; background: #f5f7fb; text-align: center; padding: 60px; color: #333; }' +
    'h1 { font-size: 42px; margin-bottom: 10px; }' +
    'p { font-size: 18px; max-width: 900px; margin: 12px auto; line-height: 1.6; }' +
    '.section-title { font-weight: bold; margin-top: 30px; font-size: 20px; }' +
    '.owner { margin-top: 25px; font-weight: bold; }' +
    '.contact { margin-top: 20px; font-weight: bold; }' +
    '.links { margin-top: 25px; }' +
    '.links a { margin: 0 10px; color: #2563eb; text-decoration: none; font-weight: bold; }' +
    'footer { margin-top: 60px; font-size: 14px; color: #777; }' +
    '</style></head><body>' +
    '<h1>Tenant Flow AI</h1>' +
    '<p>AI-powered tenant maintenance communication platform for property managers.</p>' +
    '<p>Tenants can report maintenance issues via SMS. The system acknowledges requests, classifies urgency, collects availability, and notifies the property manager automatically.</p>' +
    '<p class="section-title">How It Works</p>' +
    '<p>Tenants send a text message describing an issue. Tenant Flow AI collects all necessary details, then sends a complete summary to the property manager via SMS and email so they can schedule the repair.</p>' +
    '<p class="section-title">How to Get Started</p>' +
    '<p>Text the Tenant Flow AI phone number to report a maintenance issue. By sending the first message, you agree to receive conversational SMS responses. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p>' +
    '<p class="section-title">SMS Consent and Compliance</p>' +
    '<p>Users opt in by initiating contact via text message. Upon first contact, users automatically receive a confirmation message. No marketing messages are sent through this program.</p>' +
    '<p class="owner">Tenant Flow AI is owned and operated by Wyatt D Morgan.</p>' +
    '<p>Business Location: United States</p>' +
    '<p>Service Type: Property Management Communication Software</p>' +
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

  console.log("Incoming SMS from:", from);
  console.log("Message:", body);

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
    console.log(`[BLOCKED] ${from} is opted out.`);
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  // 5. First-time texter — send opt-in confirmation
  if (isFirstTimeTexter(from)) {
    recordOptIn(from);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  // 6. Already resolved — start fresh
  if (isResolved(from)) {
    conversations.delete(from);
    console.log(`[NEW REQUEST] ${from} starting a new request after resolution.`);
  }

  // 7. Process with Claude (with full conversation memory)
  console.log(`[PROCESSING] from ${from}: ${body}`);
  res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  processWithClaude(from, body);
});

// ─────────────────────────────────────────────
// PRIVACY POLICY
// ─────────────────────────────────────────────
app.get("/privacy", (req, res) => {
  res.status(200).send(
    '<html><head><title>Privacy Policy</title><style>body { font-family: Arial, sans-serif; background: #f5f7fb; padding: 40px; color: #333; max-width: 900px; margin: auto; line-height: 1.7; } h1 { font-size: 36px; margin-bottom: 20px; } h2 { font-size: 24px; margin-top: 30px; } p { font-size: 18px; margin-bottom: 15px; }</style></head><body>' +
    '<h1>Privacy Policy</h1>' +
    '<p>Tenant Flow AI collects phone numbers and message content to facilitate communication between tenants, property managers, and maintenance personnel.</p>' +
    '<h2>Information We Collect</h2>' +
    '<p>We may collect phone numbers, message content, maintenance issue details, and communication history.</p>' +
    '<h2>How We Use Information</h2>' +
    '<p>We use this information solely for service-related communication including maintenance requests, scheduling updates, issue resolution, and property management communication.</p>' +
    '<h2>Information Sharing</h2>' +
    '<p>Tenant Flow AI does not sell or share personal information with third parties for marketing purposes. Mobile numbers are never sold or shared.</p>' +
    '<h2>SMS Messaging and Opt-In</h2>' +
    '<p>Users opt in by sending the first text message to Tenant Flow AI. Upon first contact, users automatically receive a confirmation message. Opt-in records including phone number and timestamp are stored securely. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p>' +
    '<h2>Opt-Out</h2>' +
    '<p>Users may opt out at any time by replying STOP. No further messages will be sent unless the user replies START or UNSTOP.</p>' +
    '<h2>Contact</h2>' +
    '<p>For questions, contact wyattmorgan@tenant-flow-ai.com.</p>' +
    '</body></html>'
  );
});

// ─────────────────────────────────────────────
// TERMS & CONDITIONS
// ─────────────────────────────────────────────
app.get("/terms", (req, res) => {
  res.status(200).send(
    '<html><head><title>Terms and Conditions</title><style>body { font-family: Arial, sans-serif; background: #f5f7fb; padding: 40px; color: #333; max-width: 900px; margin: auto; line-height: 1.7; } h1 { font-size: 36px; margin-bottom: 20px; } h2 { font-size: 24px; margin-top: 30px; } p { font-size: 18px; margin-bottom: 15px; }</style></head><body>' +
    '<h1>Terms and Conditions</h1>' +
    '<p>These Terms govern the use of Tenant Flow AI messaging services.</p>' +
    '<h2>Program Description</h2>' +
    '<p>Tenant Flow AI provides SMS-based communication for maintenance requests, scheduling updates, issue resolution, and property management communication.</p>' +
    '<h2>Consent to Receive Messages</h2>' +
    '<p>Users consent by sending the first text message to Tenant Flow AI. Upon first contact, users receive an opt-in confirmation. Opt-in is recorded with a timestamp. Users may re-opt in by replying START or UNSTOP.</p>' +
    '<h2>Message Frequency</h2>' +
    '<p>Message frequency varies depending on maintenance activity and communication needs.</p>' +
    '<h2>Fees</h2>' +
    '<p>Message and data rates may apply depending on your mobile carrier and plan.</p>' +
    '<h2>Opt-Out</h2>' +
    '<p>Reply STOP at any time. No further messages will be sent after opting out.</p>' +
    '<h2>Help</h2>' +
    '<p>Reply HELP for assistance including program details and support contact.</p>' +
    '<h2>Support Contact</h2>' +
    '<p>For support, contact wyattmorgan@tenant-flow-ai.com.</p>' +
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
