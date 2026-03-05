import express from "express";

const app = express();

// Twilio sends SMS data as form data
app.use(express.urlencoded({ extended: true }));

// Test route to confirm server is running
app.get("/", (req, res) => {
  res.send("Property AI Server Running");
});

// Twilio SMS webhook
app.post("/twilio/inbound", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log("Incoming SMS from:", from);
  console.log("Message:", body);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Maintenance request received. We will contact a technician.</Message>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

// Railway assigns the port automatically
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Server running on port " + port);
});
