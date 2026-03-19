require("dotenv").config();

const cors = require("cors");
const express = require("express");
const authRouter = require("./routes/auth");

const app = express();
const port = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "backend", timestamp: new Date().toISOString() });
});

app.use("/auth", authRouter);

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
