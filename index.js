import express from "express";

const app = express();

// Twilio sends form-encoded data
app.use(express.urlencoded({ extended: false }));

// Log every request
app.use((req, res, next) => {
  console.log("[" + new Date().toISOString() + "] " + req.method + " " + req.path);
  next();
});

// Homepage
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
        '<p>Users opt in by initiating contact via text message. Tenant Flow AI only sends service-related SMS messages connected to maintenance issues, property management communication, and scheduling. No marketing messages are sent through this program.</p>' +

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

// Helpful browser test
app.get("/sms", (req, res) => {
  res.status(200).send("SMS endpoint alive. Twilio must POST here.");
});

// Inbound SMS webhook
app.post("/sms", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log("Incoming SMS from:", from);
  console.log("Message:", body);

  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Message>Tenant Flow AI: We received your message and notified the appropriate party. A technician will be there shortly to resolve the issue. Reply STOP to opt out or HELP for assistance.</Message>' +
    '</Response>';

  res.status(200).set("Content-Type", "text/xml").send(twiml);
});

// Privacy Policy page
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

    '<h2>SMS Messaging</h2>' +
    '<p>Users opt in by sending the first text message to Tenant Flow AI to report a maintenance issue or communicate with property management. By texting first, users consent to receive conversational SMS messages related to maintenance requests, updates, scheduling, and service communication. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p>' +

    '<h2>Contact</h2>' +
    '<p>For questions, contact wyattmorgan@tenant-flow-ai.com.</p>' +

    '</body></html>'
  );
});

// Terms and Conditions page
app.get("/terms", (req, res) => {
  res.status(200).send(
    '<html><head><title>Terms and Conditions</title><style>body { font-family: Arial, sans-serif; background: #f5f7fb; padding: 40px; color: #333; max-width: 900px; margin: auto; line-height: 1.7; } h1 { font-size: 36px; margin-bottom: 20px; } h2 { font-size: 24px; margin-top: 30px; } p { font-size: 18px; margin-bottom: 15px; }</style></head><body>' +

    '<h1>Terms and Conditions</h1>' +

    '<p>These Terms and Conditions govern the use of Tenant Flow AI messaging services.</p>' +

    '<h2>Program Description</h2>' +
    '<p>Tenant Flow AI provides SMS-based communication for maintenance requests, scheduling updates, issue resolution, and property management communication between tenants, property managers, and maintenance personnel.</p>' +

    '<h2>Consent to Receive Messages</h2>' +
    '<p>Users consent to receive messages by sending the first text message to Tenant Flow AI to report a maintenance issue or communicate with property management.</p>' +

    '<h2>Message Frequency</h2>' +
    '<p>Message frequency varies depending on maintenance activity, scheduling updates, and communication needs.</p>' +

    '<h2>Fees</h2>' +
    '<p>Message and data rates may apply depending on the user’s mobile carrier and messaging plan.</p>' +

    '<h2>Opt-Out</h2>' +
    '<p>Users may opt out at any time by replying STOP.</p>' +

    '<h2>Help</h2>' +
    '<p>Users may reply HELP for assistance.</p>' +

    '<h2>Support Contact</h2>' +
    '<p>For support, contact wyattmorgan@tenant-flow-ai.com.</p>' +

    '</body></html>'
  );
});

// Fallback
app.use((req, res) => {
  res.status(404).send("Not Found: " + req.method + " " + req.path);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
