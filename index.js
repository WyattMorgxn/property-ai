import express from "express";

const app = express();

// Twilio sends form-encoded data
app.use(express.urlencoded({ extended: false }));

// Log every request so you can see what Twilio is hitting
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Homepage (Landing page for your domain)
app.get("/", (req, res) => {
  res.status(200).send(`
  <html>
    <head>
      <title>Tenant Flow AI</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background-color: #f5f7fb;
          text-align: center;
          padding: 60px;
          color: #333;
        }
        h1 {
          font-size: 42px;
          margin-bottom: 10px;
        }
        p {
          font-size: 18px;
          max-width: 700px;
          margin: 10px auto;
        }
        .contact {
          margin-top: 30px;
          font-weight: bold;
        }
        footer {
          margin-top: 60px;
          font-size: 14px;
          color: #777;
        }
      </style>
    </head>

    <body>
      <h1>Tenant Flow AI</h1>

      <p>
        AI-powered tenant maintenance communication platform for property managers.
      </p>

      <p>
        Tenants can report maintenance issues via SMS. The system acknowledges
        requests, classifies urgency, and helps notify property management staff.
      </p>

      <p>
        Built to support property management communication workflows and
        maintenance request handling.
      </p>

      <p class="contact">
        Contact: wyattmorgan@tenant-flow-ai.com
      </p>

      <footer>
        © ${new Date().getFullYear()} Tenant Flow AI
      </footer>
    </body>
  </html>
  `);
});

// Helpful browser test (so /sms doesn't look "broken" in a browser)
app.get("/sms", (req, res) => {
  res.status(200).send("SMS endpoint alive. Twilio must POST here.");
});

// Inbound SMS webhook (Twilio will POST here)
app.post("/sms", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log("Incoming SMS from:", from);
  console.log("Message:", body);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Maintenance request received. We will contact a technician.</Message>
</Response>`;

  res.status(200).set("Content-Type", "text/xml").send(twiml);
});

// fallback so you see if Twilio hits the wrong path
app.use((req, res) => {
  res.status(404).send(\`Not Found: \${req.method} \${req.path}\`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port " + port));
