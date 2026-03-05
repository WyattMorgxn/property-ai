import express from "express";

const app = express();

// Twilio sends webhooks as x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// Quick health check
app.get("/", (req, res) => {
  res.status(200).send("Property AI Server Running");
});

// Function to return TwiML reply
function replyTwiml(res, message) {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${message}</Message>
</Response>`;

  res.status(200);
  res.set("Content-Type", "text/xml");
  return res.send(twiml);
}

// Handle inbound SMS (use this in Twilio webhook URL)
app.post("/sms", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log("Incoming SMS from:", from);
  console.log("Message:", body);

  return replyTwiml(res, "Maintenance request received. We will contact a technician.");
});

// ALSO support the old route, just in case your Twilio URL is still set to it
app.post("/twilio/inbound", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log("Incoming SMS from:", from);
  console.log("Message:", body);

  return replyTwiml(res, "Maintenance request received. We will contact a technician.");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port " + port));
