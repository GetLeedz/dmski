const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { validatePassword } = require("../utils/passwordPolicy");

const router = express.Router();

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) {
    return rawUrl;
  }

  const trimmed = String(rawUrl)
    .trim()
    .replace(/^['\"]|['\"]$/g, "")
    .replace(/\s+/g, "");

  try {
    // If already valid, keep as-is.
    new URL(trimmed);
    return trimmed;
  } catch {
    // Recover from unescaped password chars in postgres URLs.
    const match = trimmed.match(/^(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@([^/]+)\/(.+)$/i);
    if (!match) {
      return trimmed;
    }

    const [, protocol, user, password, host, dbPath] = match;
    return `${protocol}${user}:${encodeURIComponent(password)}@${host}/${dbPath}`;
  }
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL) });
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required");
}

// POST /auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "E-Mail und Passwort erforderlich." });
  }

  const emailNorm = String(email).trim().toLowerCase();

  try {
    const result = await pool.query(
      "SELECT id, email, password_hash FROM users WHERE email = $1 LIMIT 1",
      [emailNorm]
    );

    const user = result.rows[0];

    // Constant-time comparison to prevent timing attacks
    const dummyHash = "$2a$12$KIXLc7e6xFz0OqC1mDkwEupVr4t4gkQr4Ul5w1qPbMgJBFcNvPtmu";
    const hashToCompare = user ? user.password_hash : dummyHash;
    const match = await bcrypt.compare(password, hashToCompare);

    if (!user || !match) {
      return res.status(401).json({ error: "Ungültige E-Mail oder Passwort." });
    }

    const token = jwt.sign(
      { sub: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.json({ token, email: user.email });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Serverfehler. Bitte erneut versuchen." });
  }
});

// POST /auth/register
router.post("/register", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "E-Mail und Passwort erforderlich." });
  }

  if (!validatePassword(password)) {
    return res.status(400).json({
      error: "Passwort muss mindestens 10 Zeichen, einen Grossbuchstaben, eine Zahl und ein Sonderzeichen enthalten."
    });
  }

  const emailNorm = String(email).trim().toLowerCase();

  try {
    const exists = await pool.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1",
      [emailNorm]
    );

    if (exists.rows.length > 0) {
      return res.status(409).json({ error: "E-Mail bereits registriert." });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at",
      [emailNorm, password_hash]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { sub: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.status(201).json({ token, email: user.email });
  } catch (err) {
    console.error("Register error:", err.message);
    return res.status(500).json({ error: "Serverfehler. Bitte erneut versuchen." });
  }
});

module.exports = router;
