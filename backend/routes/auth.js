/* backend/routes/auth.js */
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { validatePassword } = require("../utils/passwordPolicy");

const router = express.Router();

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  const trimmed = String(rawUrl).trim().replace(/^['\"]|['\"]$/g, "").replace(/\s+/g, "");
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    const match = trimmed.match(/^(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@([^/]+)\/(.+)$/i);
    if (!match) return trimmed;
    const [, protocol, user, password, host, dbPath] = match;
    return `${protocol}${user}:${encodeURIComponent(password)}@${host}/${dbPath}`;
  }
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL) });
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";
let jwtSecretWarningLogged = false;

let userSchemaDone = false;
async function ensureUserSchema() {
  if (userSchemaDone) return;
  userSchemaDone = true;
  try {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'customer'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile TEXT");
    
    const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (adminEmail) {
      await pool.query("UPDATE users SET role = 'admin' WHERE email = $1", [adminEmail]);
    }
    await pool.query(`
      UPDATE users SET role = 'admin'
      WHERE id = (SELECT MIN(id) FROM users)
        AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
    `);
  } catch (err) {
    userSchemaDone = false;
    console.warn("User schema migration warning:", err.message);
  }
}

function ensureJwtSecret(res) {
  if (JWT_SECRET) return true;
  if (!jwtSecretWarningLogged) {
    console.error("JWT_SECRET environment variable is required");
    jwtSecretWarningLogged = true;
  }
  res.status(503).json({ error: "Server-Konfiguration unvollständig." });
  return false;
}

// POST /auth/login
router.post("/login", async (req, res) => {
  if (!ensureJwtSecret(res)) return;

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "E-Mail und Passwort erforderlich." });
  }

  const emailNorm = String(email).trim().toLowerCase();

  try {
    await ensureUserSchema();
    const result = await pool.query(
      "SELECT id, email, password_hash, role FROM users WHERE email = $1 LIMIT 1",
      [emailNorm]
    );

    const user = result.rows[0];
    const dummyHash = "$2a$12$KIXLc7e6xFz0OqC1mDkwEupVr4t4gkQr4Ul5w1qPbMgJBFcNvPtmu";
    const hashToCompare = user ? user.password_hash : dummyHash;
    const match = await bcrypt.compare(password, hashToCompare);

    if (!user || !match) {
      return res.status(401).json({ error: "Ungültige E-Mail oder Passwort." });
    }

    const role = user.role || "customer";
    const token = jwt.sign(
      { sub: user.id, email: user.email, role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // WICHTIG: id mitschicken!
    return res.json({ token, id: user.id, email: user.email, role });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Serverfehler." });
  }
});

// POST /auth/register
router.post("/register", async (req, res) => {
  if (!ensureJwtSecret(res)) return;

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "E-Mail und Passwort erforderlich." });
  }

  if (!validatePassword(password)) {
    return res.status(400).json({ error: "Passwort zu schwach." });
  }

  const emailNorm = String(email).trim().toLowerCase();

  try {
    const exists = await pool.query("SELECT id FROM users WHERE email = $1 LIMIT 1", [emailNorm]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: "E-Mail bereits registriert." });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role",
      [emailNorm, password_hash]
    );

    const user = result.rows[0];
    const token = jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    // WICHTIG: id mitschicken!
    return res.status(201).json({ token, id: user.id, email: user.email, role: user.role });
  } catch (err) {
    return res.status(500).json({ error: "Serverfehler." });
  }
});

module.exports = router;