const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const cors = require("cors");
const express = require("express");
const authRouter = require("./routes/auth");
const casesRouter = require("./routes/cases");
const usersRouter = require("./routes/users");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT) || (isProduction ? 8080 : 4000);
const host = "0.0.0.0";

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
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "backend", timestamp: new Date().toISOString() });
});

app.use("/auth", authRouter);
app.use("/cases", casesRouter);
app.use("/users", usersRouter);

// 404 catch-all – return JSON instead of HTML
app.use((_req, res) => {
  res.status(404).json({ error: "Route nicht gefunden." });
});

// Express 5 JSON error handler – prevents default HTML error pages
app.use((err, _req, res, _next) => {
  const status = typeof err.status === "number" ? err.status : 500;
  const message = err.expose ? err.message : (status < 500 ? err.message : "Interner Serverfehler.");
  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
});

app.listen(port, host, () => {
  console.log(`Backend running on http://${host}:${port}`);
});
