import express from "express";

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Property AI Server Running");
});

app.post("/twilio/inbound", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Maintenance request received. We will contact a technician.</Message>
</Response>`;

res.status(200).set("Content-Type", "text/xml").send(twiml);
});
