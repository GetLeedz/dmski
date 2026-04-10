const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Pool } = require("pg");
const { validatePassword, PASSWORD_HINT } = require("../utils/passwordPolicy");
const { Resend } = require("resend");

const { requireAuth } = require("../middleware/auth");
const { writeLog } = require("./audit");
const { getOrCreateBalance, ensureSchema: ensureCreditsSchema } = require("./credits");

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
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMPTZ");
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
      "SELECT id, email, password_hash, role, password_change_required, first_name, email_verified FROM users WHERE LOWER(TRIM(email)) = $1 LIMIT 1",
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
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
      writeLog({ userId: null, email: emailNorm, action: "login_failed", ip, userAgent: req.headers["user-agent"] });
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

    // Fetch credit balance
    let credits = { balance: 0 };
    try {
      await ensureCreditsSchema();
      credits = await getOrCreateBalance(user.id);
    } catch (_) { /* credits table may not exist yet */ }

    console.log(`Login erfolgreich: ${user.email}`);
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
    writeLog({ userId: user.id, email: user.email, action: "login", ip, userAgent: req.headers["user-agent"] });
    return res.json({
      token,
      id: user.id,
      email: user.email,
      role,
      first_name: user.first_name || "",
      credit_balance: credits.balance || 0,
      password_change_required: user.password_change_required || false,
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Serverfehler." });
  }
});

// POST /auth/logout – log session end
router.post("/logout", requireAuth, async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
  writeLog({ userId: req.user.sub, email: req.user.email, action: "logout", ip, userAgent: req.headers["user-agent"] });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
// POST /auth/signup – Self-registration
// ══════════════════════════════════════════════
const FROM_ADDRESS = "DMSKI Scrutor <info@dmski.ch>";

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

router.post("/signup", async (req, res) => {
  if (!ensureJwtSecret(res)) return;

  const { first_name, last_name, email, password } = req.body;
  if (!email || !password || !first_name) {
    return res.status(400).json({ error: "Vorname, E-Mail und Passwort erforderlich." });
  }

  if (!validatePassword(password)) {
    return res.status(400).json({ error: PASSWORD_HINT });
  }

  const emailNorm = String(email).trim().toLowerCase();

  try {
    await ensureUserSchema();

    // Check if email already exists
    const existing = await pool.query("SELECT id FROM users WHERE LOWER(TRIM(email)) = $1", [emailNorm]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Diese E-Mail-Adresse ist bereits registriert." });
    }

    const hash = await bcrypt.hash(String(password).trim(), 12);
    const verifyToken = crypto.randomBytes(32).toString("hex");
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const insertResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified, email_verify_token, email_verify_expires)
       VALUES ($1, $2, $3, $4, 'customer', false, $5, $6) RETURNING id`,
      [emailNorm, hash, first_name.trim(), (last_name || "").trim(), verifyToken, verifyExpires]
    );
    const userId = insertResult.rows[0].id;

    // Send verification email
    const verifyUrl = `https://dmski.ch/verify.html?token=${verifyToken}`;
    const resend = getResend();
    if (resend) {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: [emailNorm],
        subject: "DMSKI – E-Mail bestätigen",
        html: buildVerifyEmail(first_name.trim(), verifyUrl),
      });
    }

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
    writeLog({ userId, email: emailNorm, action: "signup", ip, userAgent: req.headers["user-agent"] });

    res.status(201).json({ ok: true, message: "Registrierung erfolgreich. Bitte bestätigen Sie Ihre E-Mail-Adresse." });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ error: "Registrierung fehlgeschlagen." });
  }
});

// ══════════════════════════════════════════════
// POST /auth/verify-email – Verify email token
// ══════════════════════════════════════════════
router.post("/verify-email", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token fehlt." });

  try {
    await ensureUserSchema();
    const r = await pool.query(
      `SELECT id, email, first_name, email_verified, email_verify_expires FROM users WHERE email_verify_token = $1 LIMIT 1`,
      [token]
    );
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: "Ungültiger Verifizierungslink." });
    if (user.email_verified) return res.json({ ok: true, message: "E-Mail bereits bestätigt." });
    if (new Date(user.email_verify_expires) < new Date()) {
      return res.status(410).json({ error: "Verifizierungslink abgelaufen. Bitte erneut registrieren." });
    }

    await pool.query(
      `UPDATE users SET email_verified = true, email_verify_token = NULL, email_verify_expires = NULL WHERE id = $1`,
      [user.id]
    );

    // Grant free signup credits
    try {
      await ensureCreditsSchema();
      const settingsRes = await pool.query(`SELECT free_signup_credits FROM credit_settings WHERE id = 1`);
      const freeCredits = settingsRes.rows[0]?.free_signup_credits || 10;
      if (freeCredits > 0) {
        await pool.query(
          `INSERT INTO user_credits (user_id, balance, total_purchased) VALUES ($1, $2, 0) ON CONFLICT (user_id) DO UPDATE SET balance = user_credits.balance + $2`,
          [user.id, freeCredits]
        );
        await pool.query(
          `INSERT INTO credit_transactions (user_id, type, amount, balance_after, description) VALUES ($1, 'signup_bonus', $2, $2, $3)`,
          [user.id, freeCredits, `${freeCredits} Willkommens-Credits`]
        );
      }
    } catch (creditErr) {
      console.warn("[auth] Could not grant signup credits:", creditErr.message);
    }

    writeLog({ userId: user.id, email: user.email, action: "email_verified", ip: "", userAgent: "" });
    res.json({ ok: true, message: "E-Mail bestätigt. Sie können sich jetzt anmelden." });
  } catch (err) {
    console.error("Verify error:", err.message);
    res.status(500).json({ error: "Verifizierung fehlgeschlagen." });
  }
});

function buildVerifyEmail(firstName, verifyUrl) {
  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:40px 20px;">
<tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08);">
  <tr><td style="background:#1A2B3C;padding:28px 40px;text-align:center;">
    <span style="color:#C5A059;font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;">DMSKI SCRUTOR</span>
    <p style="color:rgba(255,255,255,.5);font-size:11px;margin:5px 0 0;letter-spacing:.03em;">KI-gest&uuml;tzte forensische Fallanalyse</p>
  </td></tr>
  <tr><td style="padding:36px 40px 32px;">
    <p style="color:#1A2B3C;font-size:15px;line-height:1.7;margin:0 0 24px;">Hallo ${firstName},</p>
    <p style="color:#1A2B3C;font-size:15px;line-height:1.7;margin:0 0 24px;">Vielen Dank f&uuml;r Ihre Registrierung bei DMSKI. Bitte best&auml;tigen Sie Ihre E-Mail-Adresse:</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
      <tr><td style="background:#C5A059;border-radius:10px;text-align:center;">
        <a href="${verifyUrl}" style="display:inline-block;padding:14px 44px;color:#1A2B3C;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:.03em;">E-MAIL BEST&Auml;TIGEN &rarr;</a>
      </td></tr>
    </table>
    <p style="color:#8a96a3;font-size:12px;line-height:1.6;margin:0 0 16px;text-align:center;">Dieser Link ist 24 Stunden g&uuml;ltig.</p>
    <p style="color:#8a96a3;font-size:12px;line-height:1.6;margin:0;text-align:center;">
      Bei Fragen: <a href="mailto:info@dmski.ch" style="color:#C5A059;text-decoration:none;">info@dmski.ch</a>
    </p>
  </td></tr>
  <tr><td style="background:#f5f6f8;border-top:1px solid #e8edf2;padding:24px 40px;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#1A2B3C;">DMSKI Scrutor &middot; GetLeedz GmbH</p>
    <p style="margin:0;font-size:11px;color:#6b7b8a;">Walter F&uuml;rst-Strasse 1 &middot; CH-4102 Binningen</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = router;