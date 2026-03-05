import express from "express";

const app = express();

// Twilio sends form-encoded data
app.use(express.urlencoded({ extended: false }));

// Log every request so you can see what Twilio is hitting
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get("/", (req, res) => {
  res.status(200).send("Property AI Server Running");
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
  res.status(404).send(`Not Found: ${req.method} ${req.path}`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port " + port));
