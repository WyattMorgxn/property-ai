import express from "express";

const app = express();

// Twilio sends form-encoded data
app.use(express.urlencoded({ extended: false }));

// Log every request
app.use((req, res, next) => {
  console.log("[" + new Date().toISOString() + "] " + req.method + " " + req.path);
  next();
});

// ======================
// HOMEPAGE (UPGRADED)
// ======================
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
        '<p>Tenants send a text message describing an issue. Tenant Flow AI processes the request, categorizes urgency, and automatically notifies the appropriate property manager or maintenance personnel. Updates are sent back to the tenant via SMS.</p>' +

        '<p class="section-title">Example</p>' +
        '<p>A tenant texts "My sink is leaking." Tenant Flow AI processes the request and notifies maintenance. The tenant then receives an update such as "A technician has been scheduled and will arrive shortly."</p>' +

        '<p class="section-title">About Tenant Flow AI</p>' +
        '<p>Tenant Flow AI is a communication platform designed to streamline maintenance coordination between tenants and property managers. It improves response time, automates communication workflows, and enhances tenant satisfaction.</p>' +

        '<p class="section-title">SMS Consent & Compliance</p>' +
        '<p>Users opt in by sending a text message to Tenant Flow AI to report maintenance issues or communicate with property management. By initiating contact, users consent to receive SMS messages related to service requests, updates, scheduling, and communication. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p>' +

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

// ======================
// SMS TEST
// ======================
app.get("/sms", (req, res) => {
  res.status(200).send("SMS endpoint alive. Twilio must POST here.");
});

// ======================
// SMS WEBHOOK
// ======================
app.post("/sms", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log("Incoming SMS from:", from);
  console.log("Message:", body);

  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Message>Tenant Flow AI: Your request has been received and forwarded. A technician will be there shortly to resolve the issue.</Message>' +
    '</Response>';

  res.status(200).set("Content-Type", "text/xml").send(twiml);
});

// ======================
// PRIVACY POLICY (STRONG)
// ======================
app.get("/privacy", (req, res) => {
  res.status(200).send(
    '<html><head><title>Privacy Policy</title></head><body style="font-family: Arial; padding:40px; max-width:900px; margin:auto;">' +

    '<h1>Privacy Policy</h1>' +

    '<p>Tenant Flow AI collects phone numbers and message content for the purpose of facilitating communication between tenants, property managers, and maintenance personnel.</p>' +

    '<p>Information is used strictly for service-related communication such as maintenance requests, updates, and scheduling.</p>' +

    '<p>Tenant Flow AI does not sell or share personal data with third parties for marketing purposes.</p>' +

    '<p>By messaging Tenant Flow AI, users consent to receive SMS messages related to service requests and communication.</p>' +

    '<p>Message frequency varies. Message and data rates may apply.</p>' +

    '<p>Users can opt out at any time by replying STOP or request help by replying HELP.</p>' +

    '<p>Contact: wyattmorgan@tenant-flow-ai.com</p>' +

    '</body></html>'
  );
});

// ======================
// TERMS (STRONG)
// ======================
app.get("/terms", (req, res) => {
  res.status(200).send(
    '<html><head><title>Terms and Conditions</title></head><body style="font-family: Arial; padding:40px; max-width:900px; margin:auto;">' +

    '<h1>Terms and Conditions</h1>' +

    '<p>Tenant Flow AI provides SMS-based communication for maintenance requests and property management coordination.</p>' +

    '<p>By using this service, you agree to receive conversational SMS messages related to tenant communication and maintenance coordination.</p>' +

    '<p>Message frequency varies depending on activity and updates.</p>' +

    '<p>Message and data rates may apply.</p>' +

    '<p>To opt out, reply STOP at any time. For assistance, reply HELP.</p>' +

    '<p>For support, contact wyattmorgan@tenant-flow-ai.com.</p>' +

    '</body></html>'
  );
});

// ======================
// FALLBACK
// ======================
app.use((req, res) => {
  res.status(404).send("Not Found: " + req.method + " " + req.path);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
