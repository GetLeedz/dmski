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

let userSchemaDone = false;
async function ensureUserSchema() {
  if (userSchemaDone) return;
  userSchemaDone = true;
  try {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'customer'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS salutation TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS academic_title TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0");
    const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (adminEmail) {
      await pool.query("UPDATE users SET role = 'admin' WHERE LOWER(TRIM(email)) = $1", [adminEmail]);
    }
  } catch (err) {
    userSchemaDone = false;
    console.warn("Schema Info:", err.message);
  }
}

function ensureJwtSecret(res) {
  if (JWT_SECRET) return true;
  res.status(503).json({ error: "Server-Konfiguration unvollständig (JWT_SECRET)." });
  return false;
}

// POST /auth/login
router.post("/login", async (req, res) => {
  if (!ensureJwtSecret(res)) return;

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "E-Mail und Passwort erforderlich." });
  }

  // Normalisierung für den Vergleich
  const emailNorm = String(email).trim().toLowerCase();

  try {
    await ensureUserSchema();
    
    // WICHTIG: Nutze LOWER(TRIM()) auch hier in der Abfrage!
    const result = await pool.query(
      "SELECT id, email, password_hash, role, password_change_required FROM users WHERE LOWER(TRIM(email)) = $1 LIMIT 1",
      [emailNorm]
    );

    const user = result.rows[0];
    
    // Schutz gegen Timing-Attacks
    const dummyHash = "$2a$12$KIXLc7e6xFz0OqC1mDkwEupVr4t4gkQr4Ul5w1qPbMgJBFcNvPtmu";
    const hashToCompare = user ? user.password_hash : dummyHash;
    
    // Passwort trimmen, falls Leerzeichen beim Einfügen mitkamen
    const match = await bcrypt.compare(String(password).trim(), hashToCompare);

    if (!user || !match) {
      console.log(`Login fehlgeschlagen für: ${emailNorm}`);
      return res.status(401).json({ error: "Ungültige E-Mail oder Passwort." });
    }

    // Login-Tracking: Zeitstempel und Zähler aktualisieren
    await pool.query(
      "UPDATE users SET last_login_at = NOW(), login_count = COALESCE(login_count, 0) + 1 WHERE id = $1",
      [user.id]
    );

    const role = user.role || "customer";
    const token = jwt.sign(
      { sub: user.id, email: user.email, role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    console.log(`Login erfolgreich: ${user.email}`);
    return res.json({
      token,
      id: user.id,
      email: user.email,
      role,
      password_change_required: user.password_change_required || false,
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Serverfehler." });
  }
});

module.exports = router;