import express from "express";
import nodemailer from "nodemailer";

const app = express();

// Twilio sends form-encoded data
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────────
// PROPERTY LOOKUP TABLE
// Maps tenant phone number → property info + manager contact
// Add new tenants here as you onboard them
// ─────────────────────────────────────────────
const PROPERTIES = {
  "+19377033507": {
    address: "324 Warner Street Cincinnati Ohio 45219",
    managerName: "Wyatt Morgan",
    managerPhone: "+14192964656",
    managerEmail: "Morgaw23@gmail.com",
  },
  // Add more tenants below like this:
  // "+1XXXXXXXXXX": {
  //   address: "123 Main St Cincinnati OH 45000",
  //   managerName: "Wyatt Morgan",
  //   managerPhone: "+14192964656",
  //   managerEmail: "Morgaw23@gmail.com",
  // },
};

// Default manager (used if tenant is not in the lookup table)
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
// COMPLIANCE MESSAGE TEMPLATES
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
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({ To: to, From: TWILIO_PHONE_NUMBER, Body: message });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("[TWILIO ERROR]", data);
  } else {
    console.log(`[SMS SENT] to ${to}`);
  }
}

// ─────────────────────────────────────────────
// EMAIL (nodemailer via Gmail)
// ─────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS,
  },
});

async function sendEmail(to, subject, body) {
  try {
    await transporter.sendMail({
      from: `"Tenant Flow AI" <${GMAIL_USER}>`,
      to,
      subject,
      text: body,
    });
    console.log(`[EMAIL SENT] to ${to}: ${subject}`);
  } catch (err) {
    console.error("[EMAIL ERROR]", err);
  }
}

// ─────────────────────────────────────────────
// NOTIFY PROPERTY MANAGER (SMS + Email)
// ─────────────────────────────────────────────
async function notifyManager(tenantPhone, tenantMessage, claudeReply, urgency) {
  const property = getProperty(tenantPhone);

  const smsMessage =
    `TENANT FLOW AI ALERT\n` +
    `Property: ${property.address}\n` +
    `Tenant: ${tenantPhone}\n` +
    `Urgency: ${urgency}\n` +
    `Issue: ${tenantMessage}`;

  const emailBody =
    `New Maintenance Request\n\n` +
    `Property: ${property.address}\n` +
    `Tenant Phone: ${tenantPhone}\n` +
    `Urgency: ${urgency}\n\n` +
    `Tenant Message:\n${tenantMessage}\n\n` +
    `AI Response Sent to Tenant:\n${claudeReply}\n\n` +
    `---\nTenant Flow AI`;

  const emailSubject = `[${urgency}] Maintenance Request - ${property.address}`;

  // Send both SMS and email to manager
  await Promise.all([
    sendSms(property.managerPhone, smsMessage),
    sendEmail(property.managerEmail, emailSubject, emailBody),
  ]);
}

// ─────────────────────────────────────────────
// CLAUDE AI
// ─────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are Tenant Flow AI, a helpful property management assistant.
Your job is to help tenants report maintenance issues and get help quickly.

When a tenant texts you:
1. Acknowledge their issue warmly and professionally
2. Classify the urgency as one of: EMERGENCY (gas leak, flooding, no heat in winter, electrical hazard), URGENT (no hot water, broken lock, major appliance failure), or ROUTINE (minor repairs, cosmetic issues)
3. Let them know what happens next
4. Keep your response concise - this is SMS so aim for 2-3 sentences max
5. Always end with "Reply STOP to opt out or HELP for assistance."

For EMERGENCY issues, say a property manager has been alerted immediately.
For URGENT issues, say someone will follow up within a few hours.
For ROUTINE issues, say it will be scheduled within 1-2 business days.

IMPORTANT: At the very end of your response, on a new line, write exactly:
URGENCY: EMERGENCY
or
URGENCY: URGENT
or
URGENCY: ROUTINE

This line will be stripped before sending to the tenant.`;

function parseUrgency(text) {
  const match = text.match(/URGENCY:\s*(EMERGENCY|URGENT|ROUTINE)/i);
  return match ? match[1].toUpperCase() : "ROUTINE";
}

function stripUrgencyLine(text) {
  return text.replace(/\nURGENCY:\s*(EMERGENCY|URGENT|ROUTINE)/i, "").trim();
}

async function processWithClaude(tenantPhone, message) {
  try {
    console.log(`[CLAUDE] Processing from ${tenantPhone}: ${message}`);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: message }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("[CLAUDE ERROR]", data);
      await sendSms(tenantPhone,
        "Tenant Flow AI: We received your maintenance request and will follow up shortly. " +
        "Reply STOP to opt out or HELP for assistance."
      );
      return;
    }

    const rawReply = data.content[0].text;
    const urgency  = parseUrgency(rawReply);
    const reply    = stripUrgencyLine(rawReply);

    console.log(`[CLAUDE REPLY] Urgency: ${urgency} | ${reply}`);

    // Send reply to tenant
    await sendSms(tenantPhone, reply);

    // Notify property manager via SMS + email
    await notifyManager(tenantPhone, message, reply, urgency);

  } catch (err) {
    console.error("[CLAUDE EXCEPTION]", err);
    await sendSms(tenantPhone,
      "Tenant Flow AI: We received your maintenance request and will follow up shortly. " +
      "Reply STOP to opt out or HELP for assistance."
    );
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function twimlResponse(message) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response><Message>" + message + "</Message></Response>"
  );
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
    '<p>Tenants can report maintenance issues via SMS. The system acknowledges requests, classifies urgency, and notifies property management staff.</p>' +
    '<p class="section-title">How It Works</p>' +
    '<p>Tenants send a text message describing an issue. Tenant Flow AI processes the request, categorizes urgency, notifies the appropriate property manager via SMS and email, and sends updates back to the tenant.</p>' +
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

  // 5. First-time texter
  if (isFirstTimeTexter(from)) {
    recordOptIn(from);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  // 6. Returning opted-in tenant — process with Claude + notify manager
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
