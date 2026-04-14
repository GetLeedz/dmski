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
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_ip TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_user_agent TEXT");
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
      "SELECT id, email, password_hash, role, password_change_required, first_name, email_verified, deleted_at, terms_accepted_at, terms_version FROM users WHERE LOWER(TRIM(email)) = $1 LIMIT 1",
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

    // Soft-gelöschte Benutzer können sich nicht mehr einloggen.
    // Sicherheit: gleiche generische Meldung wie bei unbekannter E-Mail,
    // damit Angreifer nicht herausfinden können, ob ein Konto existiert(e).
    if (user.deleted_at) {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
      writeLog({ userId: user.id, email: emailNorm, action: "login_blocked_deleted", ip, userAgent: req.headers["user-agent"] });
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
      terms_accepted_at: user.terms_accepted_at || null,
      terms_version: user.terms_version || null,
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Serverfehler." });
  }
});

// POST /auth/accept-terms – User akzeptiert Nutzungsbedingungen + Datenschutz
router.post("/accept-terms", requireAuth, async (req, res) => {
  try {
    await ensureUserSchema();
    const version = String(req.body?.version || "").trim() || "2026-04-14";
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
    const userAgent = String(req.headers["user-agent"] || "").slice(0, 500);

    await pool.query(
      `UPDATE users
          SET terms_accepted_at = NOW(),
              terms_version = $1,
              terms_accepted_ip = $2,
              terms_accepted_user_agent = $3
        WHERE id = $4`,
      [version, ip, userAgent, req.user.sub]
    );

    writeLog({
      userId: req.user.sub,
      email: req.user.email,
      action: `terms_accepted:${version}`,
      ip,
      userAgent
    });

    return res.json({ ok: true, terms_accepted_at: new Date().toISOString(), terms_version: version });
  } catch (err) {
    console.error("accept-terms error:", err.message);
    return res.status(500).json({ error: "Annahme konnte nicht gespeichert werden." });
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
const FROM_ADDRESS = "DMSKI <info@dmski.ch>";

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

    const hash = await bcrypt.hash(String(password).trim(), 12);
    const verifyToken = crypto.randomBytes(32).toString("hex");
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
    const generic201 = { ok: true, message: "Registrierung erfolgreich. Bitte bestätigen Sie Ihre E-Mail-Adresse." };

    // Check existing user (including soft-deleted)
    const existing = await pool.query(
      "SELECT id, deleted_at, role FROM users WHERE LOWER(TRIM(email)) = $1 LIMIT 1",
      [emailNorm]
    );
    const existingUser = existing.rows[0];

    // Case A: Admin-Konten lassen wir unberührt (zusätzliche Safety-Schicht)
    if (existingUser && existingUser.role === "admin") {
      writeLog({ userId: null, email: emailNorm, action: "signup_blocked_admin", ip, userAgent: req.headers["user-agent"] });
      return res.status(201).json(generic201);
    }

    // Case B: Aktiver Account existiert bereits → silent success, keine Info-Leakage,
    // echter Besitzer erhält keine E-Mail. Account-Enumeration wird verhindert.
    if (existingUser && !existingUser.deleted_at) {
      writeLog({ userId: existingUser.id, email: emailNorm, action: "signup_silent_existing", ip, userAgent: req.headers["user-agent"] });
      return res.status(201).json(generic201);
    }

    // Case C: Soft-gelöschter Account → reaktivieren mit neuem Passwort + Verify-Flow
    if (existingUser && existingUser.deleted_at) {
      // Safety net: Alte Credit-Daten wegräumen, falls ein vorheriger Delete-Pfad sie
      // nicht gecleant hat. Sonst würde der Willkommens-Bonus oben draufaddiert.
      await pool.query("DELETE FROM user_credits WHERE user_id = $1", [existingUser.id]).catch(() => {});
      await pool.query("DELETE FROM credit_transactions WHERE user_id = $1", [existingUser.id]).catch(() => {});

      await pool.query(
        `UPDATE users
            SET password_hash = $1,
                first_name = $2,
                last_name = $3,
                role = 'customer',
                email_verified = false,
                email_verify_token = $4,
                email_verify_expires = $5,
                deleted_at = NULL,
                invited_at = NULL,
                last_login_at = NULL,
                login_count = 0,
                password_change_required = false
          WHERE id = $6`,
        [hash, first_name.trim(), (last_name || "").trim(), verifyToken, verifyExpires, existingUser.id]
      );

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

      writeLog({ userId: existingUser.id, email: emailNorm, action: "signup_reactivated", ip, userAgent: req.headers["user-agent"] });
      return res.status(201).json(generic201);
    }

    // Case D: Neuer Benutzer → Insert
    const insertResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified, email_verify_token, email_verify_expires)
       VALUES ($1, $2, $3, $4, 'customer', false, $5, $6) RETURNING id`,
      [emailNorm, hash, first_name.trim(), (last_name || "").trim(), verifyToken, verifyExpires]
    );
    const userId = insertResult.rows[0].id;

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

    writeLog({ userId, email: emailNorm, action: "signup", ip, userAgent: req.headers["user-agent"] });
    res.status(201).json(generic201);
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

    // Grant free signup credits — idempotent: nur wenn noch kein Bonus gebucht ist
    try {
      await ensureCreditsSchema();
      const alreadyGranted = await pool.query(
        `SELECT 1 FROM credit_transactions WHERE user_id = $1 AND type = 'signup_bonus' LIMIT 1`,
        [user.id]
      );
      if (alreadyGranted.rows.length === 0) {
        const settingsRes = await pool.query(`SELECT free_signup_credits FROM credit_settings WHERE id = 1`);
        const freeCredits = settingsRes.rows[0]?.free_signup_credits ?? 10;
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
      } else {
        console.log(`[verify] Signup bonus already granted for user ${user.id} — skipped.`);
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
  <tr><td style="background:#1A2B3C;padding:32px 40px;text-align:center;">
    <img src="https://www.dmski.ch/assets/logo-dmski_gold.png" alt="DMSKI" width="140" style="display:inline-block;max-width:140px;height:auto;border:0;outline:none;text-decoration:none;" />
  </td></tr>
  <tr><td style="padding:40px 40px 32px;">
    <p style="color:#1A2B3C;font-size:17px;font-weight:600;line-height:1.5;margin:0 0 20px;">Herzlich willkommen, ${firstName} &#128075;</p>
    <p style="color:#1A2B3C;font-size:15px;line-height:1.7;margin:0 0 28px;">schön, dass Sie bei DMSKI dabei sind. Nur noch ein kleiner Schritt &mdash; bitte bestätigen Sie kurz Ihre E-Mail-Adresse, danach können Sie direkt loslegen:</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
      <tr><td style="background:#C5A059;border-radius:10px;text-align:center;">
        <a href="${verifyUrl}" style="display:inline-block;padding:15px 44px;color:#1A2B3C;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:.02em;">E-Mail bestätigen &rarr;</a>
      </td></tr>
    </table>
    <p style="color:#8a96a3;font-size:12px;line-height:1.6;margin:0 0 20px;text-align:center;">Der Link ist 24 Stunden gültig.</p>
    <p style="color:#8a96a3;font-size:13px;line-height:1.6;margin:0;text-align:center;">
      Fragen? Schreiben Sie uns an <a href="mailto:info@dmski.ch" style="color:#C5A059;text-decoration:none;font-weight:600;">info@dmski.ch</a> &mdash; wir helfen Ihnen gerne persönlich weiter.
    </p>
  </td></tr>
  <tr><td style="background:#f5f6f8;border-top:1px solid #e8edf2;padding:24px 40px;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#1A2B3C;">DMSKI &middot; GetLeedz GmbH</p>
    <p style="margin:0;font-size:11px;color:#6b7b8a;">Walter Fürst-Strasse 1 &middot; CH-4102 Binningen</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = router;