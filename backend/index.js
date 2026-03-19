require("dotenv").config();

const cors = require("cors");
const express = require("express");
const authRouter = require("./routes/auth");

const app = express();
const port = Number(process.env.PORT) || 4000;

const allowedOrigins = [
  "https://dmski.aikmu.ch",
  "https://dmski.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "backend", timestamp: new Date().toISOString() });
});

app.use("/auth", authRouter);

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
