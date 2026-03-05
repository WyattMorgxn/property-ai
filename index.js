import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  res.send("Property AI Server Running");
});

app.post("/twilio/inbound", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log("Message from:", from);
  console.log("Message:", body);

  res
    .status(200)
    .type("text/xml")
    .send(`<Response>
<Message>Maintenance request received. We will contact a technician.</Message>
</Response>`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port " + port));
