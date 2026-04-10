const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const cors = require("cors");
const express = require("express");

const authRouter = require("./routes/auth");
const casesRouter = require("./routes/cases");
const usersRouter = require("./routes/users");
const contactRouter = require("./routes/contact");
const auditRouter = require("./routes/audit");
const creditsRouter = require("./routes/credits");

const app = express();
const port = Number(process.env.PORT) || 8080;
const host = "0.0.0.0";

const allowedOrigins = [
  "https://dmski.ch",
  "https://www.dmski.ch",
  "http://localhost:5173",
  "http://localhost:3000"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  credentials: true,
  optionsSuccessStatus: 200 
}));

// Stripe webhook needs raw body BEFORE json parsing
app.use("/credits/webhook", express.raw({ type: "application/json" }));
app.use("/api/credits/webhook", express.raw({ type: "application/json" }));

app.use(express.json());

// Health Check
app.get("/health", (_req, res) => res.json({ ok: true }));

// DOPPEL-ROUTING: Akzeptiert /auth/login UND /api/auth/login
app.use("/auth", authRouter);
app.use("/api/auth", authRouter);

app.use("/cases", casesRouter);
app.use("/api/cases", casesRouter);

app.use("/users", usersRouter);
app.use("/api/users", usersRouter);

app.use("/contact", contactRouter);
app.use("/api/contact", contactRouter);

app.use("/audit", auditRouter);
app.use("/api/audit", auditRouter);

app.use("/credits", creditsRouter);
app.use("/api/credits", creditsRouter);

// 404 Handler
app.use((_req, res) => res.status(404).json({ error: "Route nicht gefunden." }));

// Error Handler
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Interner Serverfehler" });
});

app.listen(port, host, () => {
  console.log(`Backend läuft auf Port ${port}`);
});