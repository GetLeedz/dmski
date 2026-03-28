const path = require("path");
// Lädt .env aus dem aktuellen Verzeichnis
require("dotenv").config({ path: path.join(__dirname, ".env") });

const cors = require("cors");
const express = require("express");

// Router Imports (Stelle sicher, dass diese Dateien existieren!)
const authRouter = require("./routes/auth");
const casesRouter = require("./routes/cases");
const usersRouter = require("./routes/users");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT) || 8080;
const host = "0.0.0.0";

// Erlaubte Domains
const allowedOrigins = [
  "https://dmski.aikmu.ch",
  "https://dmski.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000"
];

// CORS-Konfiguration (Optimiert für Credentials & Preflight)
app.use(cors({
  origin: function (origin, callback) {
    // Erlaube Requests ohne Origin (wie Postman oder curl) oder wenn in allowedOrigins
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.error(`CORS blockiert für Origin: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  credentials: true,
  optionsSuccessStatus: 200 // Wichtig für ältere Browser & einige Preflights
}));

app.use(express.json());

// Health Check
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "backend", timestamp: new Date().toISOString() });
});

// API Routen
app.use("/api/auth", authRouter);
app.use("/api/cases", casesRouter);
app.use("/api/users", usersRouter); // Dies ist die Route für deine users.js

// 404 Catch-all (Gibt JSON statt HTML zurück)
app.use((_req, res) => {
  res.status(404).json({ error: "Route nicht gefunden." });
});

// Zentraler Error Handler
app.use((err, _req, res, _next) => {
  const status = typeof err.status === "number" ? err.status : 500;
  console.error(`[Error ${status}]: ${err.message}`);
  
  if (!res.headersSent) {
    res.status(status).json({ 
      error: status < 500 ? err.message : "Interner Serverfehler." 
    });
  }
});

app.listen(port, host, () => {
  console.log(`Backend running on http://${host}:${port}`);
  console.log(`Allowed Origins: ${allowedOrigins.join(", ")}`);
});