import express from "express";

const app = express();

// Twilio sends form-encoded data
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────────
// OPT-IN STORE
// In-memory for now — swap this for a real DB
// (Railway Postgres or Redis) in production so
// it survives restarts.
// ─────────────────────────────────────────────
const optedInUsers = new Map();   // phone → { timestamp, optedOut }

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

// Keywords Twilio auto-handles for STOP, but we log them ourselves too
const STOP_KEYWORDS  = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "UNSTOP", "YES"]);

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function twimlResponse(message) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response>" +
    "<Message>" + message + "</Message>" +
    "</Response>"
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
    '<html>' +
      '<head>' +
        '<title>Tenant Flow AI</title>' +
        '<style>' +
          'body { font-family: Arial, sans-serif; background: #f5f7fb; text-align: center; padding: 60px; color: #333; }' +
          'h1 { font-size: 42px; margin-bottom: 10px; }' +
          'p { font-size: 18px; max-width: 900px; margin: 12px auto; line-height: 1.6; }' +
          '.section-title { font-weight: bold; margin-top: 30px; font-size: 20px; }' +
          '.owner { margin-top: 25px; font-weight: bold; }' +
          '.contact { margin-top: 20px; font-weight: bold; }' +
          '.links { margin-top: 25px; }' +
          '.links a { margin: 0 10px; color: #2563eb; text-decoration: none; font-weight: bold; }' +
          'footer { margin-top: 60px; font-size: 14px; color: #777; }' +
        '</style>' +
      '</head>' +
      '<body>' +

        '<h1>Tenant Flow AI</h1>' +

        '<p>AI-powered tenant maintenance communication platform for property managers.</p>' +

        '<p>Tenants can report maintenance issues via SMS. The system acknowledges requests, classifies urgency, and helps notify property management staff.</p>' +

        '<p>Built to support property management communication workflows and maintenance request handling.</p>' +

        '<p class="section-title">How It Works</p>' +
        '<p>Tenants send a text message describing an issue. Tenant Flow AI processes the request, categorizes urgency, and automatically notifies the appropriate property manager or maintenance personnel. Updates are then sent back to the tenant via SMS.</p>' +

        '<p class="section-title">Example</p>' +
        '<p>A tenant texts "My sink is leaking." Tenant Flow AI processes the issue, notifies the appropriate maintenance contact, and sends updates back to the tenant such as "A technician has been scheduled and will arrive shortly."</p>' +

        '<p class="section-title">About Tenant Flow AI</p>' +
        '<p>Tenant Flow AI is a communication platform designed to streamline maintenance coordination between tenants and property managers. It improves response time, automates communication workflows, and enhances tenant satisfaction.</p>' +

        '<p class="section-title">How to Get Started</p>' +
        '<p>Tenants can start by texting the Tenant Flow AI phone number to report a maintenance issue or communicate with property management. By sending the first text message, the tenant agrees to receive conversational SMS responses related to maintenance issues, scheduling updates, service communication, and issue resolution. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p>' +

        '<p class="section-title">SMS Consent & Compliance</p>' +
        '<p>Users opt in by initiating contact via text message. Upon first contact, users automatically receive a confirmation message acknowledging their opt-in and explaining their rights. Tenant Flow AI only sends service-related SMS messages connected to maintenance issues, property management communication, and scheduling. No marketing messages are sent through this program.</p>' +

        '<p class="owner">Tenant Flow AI is owned and operated by Wyatt D Morgan.</p>' +

        '<p>Business Location: United States</p>' +
        '<p>Service Type: Property Management Communication Software</p>' +

        '<p class="contact">Contact: wyattmorgan@tenant-flow-ai.com</p>' +

        '<div class="links">' +
          '<a href="/privacy">Privacy Policy</a> | ' +
          '<a href="/terms">Terms & Conditions</a>' +
        '</div>' +

        '<footer>&copy; 2026 Tenant Flow AI</footer>' +

      '</body>' +
    '</html>'
  );
});

// ─────────────────────────────────────────────
// SMS ENDPOINT — GET (browser health check)
// ─────────────────────────────────────────────
app.get("/sms", (req, res) => {
  res.status(200).send("SMS endpoint alive. Twilio must POST here.");
});

// ─────────────────────────────────────────────
// SMS ENDPOINT — POST (Twilio webhook)
// ─────────────────────────────────────────────
app.post("/sms", (req, res) => {
  const from = req.body.From || "";
  const body = (req.body.Body || "").trim();
  const keyword = body.toUpperCase();

  console.log("Incoming SMS from:", from);
  console.log("Message:", body);

  // 1. STOP / opt-out keywords
  //    Twilio auto-responds and blocks future messages, but we log it ourselves.
  if (STOP_KEYWORDS.has(keyword)) {
    recordOptOut(from);
    // Return empty TwiML — Twilio sends its own STOP reply
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  // 2. START / UNSTOP — re-opt them in
  if (START_KEYWORDS.has(keyword)) {
    recordOptIn(from);
    return res
      .status(200)
      .set("Content-Type", "text/xml")
      .send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  // 3. HELP keyword
  if (keyword === "HELP") {
    return res
      .status(200)
      .set("Content-Type", "text/xml")
      .send(twimlResponse(HELP_REPLY));
  }

  // 4. Opted-out users — do not respond
  if (isOptedOut(from)) {
    console.log(`[BLOCKED] ${from} is opted out, ignoring message.`);
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  // 5. First-time texter — send opt-in confirmation FIRST, then process
  if (isFirstTimeTexter(from)) {
    recordOptIn(from);

    // Send the opt-in confirmation as the first reply.
    // The tenant's actual request will be handled on their next message,
    // OR you can chain a second Twilio outbound message here using the REST API
    // so they get both the confirmation AND the acknowledgement in one go.
    return res
      .status(200)
      .set("Content-Type", "text/xml")
      .send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  // 6. Returning, opted-in tenant — process their maintenance request
  //    👇 Put your Claude / routing logic here
  console.log(`[PROCESSING] Maintenance request from ${from}: ${body}`);

  const twiml = twimlResponse(
    "Tenant Flow AI: We received your message and notified the appropriate party. " +
    "A technician will be in touch shortly to resolve the issue. " +
    "Reply STOP to opt out or HELP for assistance."
  );

  return res.status(200).set("Content-Type", "text/xml").send(twiml);
});

// ─────────────────────────────────────────────
// PRIVACY POLICY
// ─────────────────────────────────────────────
app.get("/privacy", (req, res) => {
  res.status(200).send(
    '<html><head><title>Privacy Policy</title><style>body { font-family: Arial, sans-serif; background: #f5f7fb; padding: 40px; color: #333; max-width: 900px; margin: auto; line-height: 1.7; } h1 { font-size: 36px; margin-bottom: 20px; } h2 { font-size: 24px; margin-top: 30px; } p { font-size: 18px; margin-bottom: 15px; }</style></head><body>' +

    '<h1>Privacy Policy</h1>' +

    '<p>Tenant Flow AI collects phone numbers and message content for the purpose of facilitating communication between tenants, property managers, and maintenance personnel.</p>' +

    '<h2>Information We Collect</h2>' +
    '<p>We may collect phone numbers, message content, maintenance issue details, and communication history when users interact with the platform.</p>' +

    '<h2>How We Use Information</h2>' +
    '<p>We use this information solely for service-related communication, including maintenance requests, scheduling updates, issue resolution, and property management communication.</p>' +

    '<h2>Information Sharing</h2>' +
    '<p>Tenant Flow AI does not sell or share personal information with third parties for marketing purposes. Information is only used as necessary to coordinate requested services or comply with legal obligations.</p>' +

    '<h2>SMS Messaging & Opt-In</h2>' +
    '<p>Users opt in by sending the first text message to Tenant Flow AI to report a maintenance issue or communicate with property management. Upon first contact, users automatically receive a confirmation message acknowledging their opt-in and informing them of their communication rights. Opt-in records including phone number and timestamp are stored securely. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p>' +

    '<h2>Opt-Out</h2>' +
    '<p>Users may opt out at any time by replying STOP. Once opted out, no further messages will be sent unless the user re-initiates contact by replying START or UNSTOP.</p>' +

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

    '<p>These Terms and Conditions govern the use of Tenant Flow AI messaging services.</p>' +

    '<h2>Program Description</h2>' +
    '<p>Tenant Flow AI provides SMS-based communication for maintenance requests, scheduling updates, issue resolution, and property management communication between tenants, property managers, and maintenance personnel.</p>' +

    '<h2>Consent to Receive Messages</h2>' +
    '<p>Users consent to receive messages by sending the first text message to Tenant Flow AI. Upon first contact, users receive an automated opt-in confirmation message. Opt-in is recorded with a timestamp. Users may re-opt in at any time by replying START or UNSTOP.</p>' +

    '<h2>Message Frequency</h2>' +
    '<p>Message frequency varies depending on maintenance activity, scheduling updates, and communication needs.</p>' +

    '<h2>Fees</h2>' +
    '<p>Message and data rates may apply depending on the user\'s mobile carrier and messaging plan.</p>' +

    '<h2>Opt-Out</h2>' +
    '<p>Users may opt out at any time by replying STOP. No further messages will be sent after opting out.</p>' +

    '<h2>Help</h2>' +
    '<p>Users may reply HELP for assistance. A help message with program details and support contact will be returned.</p>' +

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
