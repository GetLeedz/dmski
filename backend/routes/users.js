const express = require("express");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const { requireAuth, requireAdmin, requireAdminOrSelf } = require("../middleware/auth");

const router = express.Router();

// 1. Datenbank-Verbindung (Normalisiert für Railway/Supabase)
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

// 2. Mail-Konfiguration
function createMailTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || "asmtp.mail.hostpoint.ch",
    port:   Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: {
      user: process.env.SMTP_USER || "dmski@aikmu.ch",
      pass: process.env.SMTP_PASS || "j+TqF5qsEqCS2d*&",
    },
  });
}

function escHtmlEmail(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*";
  let pwd = "";
  for (let i = 0; i < 14; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

// 3. Schema-Sicherung (Stellt sicher, dass die Tabellenstruktur passt)
async function ensureUserProfileColumns() {
  try {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'customer'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT, ADD COLUMN IF NOT EXISTS last_name TEXT, ADD COLUMN IF NOT EXISTS mobile TEXT, ADD COLUMN IF NOT EXISTS function_label TEXT, ADD COLUMN IF NOT EXISTS case_id TEXT");
  } catch (err) {
    console.warn("Schema-Update Warnung:", err.message);
  }
}

// --- API ROUTEN ---

// GET /api/users/me (Eigenes Profil)
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, role, first_name, last_name, function_label, case_id FROM users WHERE id = $1",
      [req.user.sub]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Profilfehler" });
  }
});

// GET /api/users (Alle Benutzer - nur Admin)
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureUserProfileColumns();
    const result = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.mobile, u.function_label, u.case_id, u.role, c.case_name 
       FROM users u LEFT JOIN cases c ON c.id::text = u.case_id 
       ORDER BY u.created_at ASC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Liste" });
  }
});

// GET /api/users/:userId/users (Liste der Fachpersonen für einen Fall/Kunden)
router.get("/:userId/users", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  try {
    await ensureUserProfileColumns();
    const result = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.mobile, u.function_label, u.case_id, u.role, c.case_name 
       FROM users u LEFT JOIN cases c ON c.id::text = u.case_id 
       WHERE u.role != 'admin' ORDER BY u.created_at ASC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Liste" });
  }
});

// POST /api/users/:userId/users (Benutzer anlegen/verknüpfen)
router.post("/:userId/users", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  const { email, first_name, last_name, mobile, function_label, case_id } = req.body;
  if (!email) return res.status(400).json({ error: "E-Mail fehlt" });

  try {
    const pwd = generatePassword();
    const hash = await bcrypt.hash(pwd, 12);
    const emailNorm = email.toLowerCase().trim();
    const role = function_label ? 'collaborator' : 'customer';

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, mobile, function_label, case_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email) DO UPDATE SET function_label = $7, case_id = $8, role = $3
       RETURNING id, email`,
      [emailNorm, hash, role, first_name, last_name, mobile, function_label, case_id]
    );

    res.status(201).json({ user: result.rows[0], generatedPassword: pwd });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Anlegen" });
  }
});

// PATCH /api/users/:editId (Benutzer bearbeiten)
router.patch("/:editId", requireAuth, async (req, res) => {
  try {
    const { first_name, last_name, email, mobile, function_label, case_id } = req.body;
    const role = function_label ? 'collaborator' : 'customer';
    const emailNorm = email ? email.toLowerCase().trim() : undefined;
    
    await pool.query(
      `UPDATE users 
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name),
           email = COALESCE($3, email),
           mobile = COALESCE($4, mobile),
           function_label = $5,
           case_id = $6,
           role = $7
       WHERE id = $8`,
      [first_name, last_name, emailNorm, mobile, function_label, case_id, role, req.params.editId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Aktualisieren" });
  }
});

// POST /api/users/:userId/users/:linkId/send-invite (MANUELLER E-MAIL VERSAND)
router.post("/:userId/users/:linkId/send-invite", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  try {
    const { linkId } = req.params;
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [linkId]);
    const user = userRes.rows[0];

    if (!user) return res.status(404).json({ error: "Benutzer nicht gefunden" });

    const transporter = createMailTransport();
    await transporter.sendMail({
      from: `"DMSKI Plattform" <${process.env.SMTP_USER || "dmski@aikmu.ch"}>`,
      to: user.email,
      subject: `Einladung zur DMSKI-Plattform`,
      html: `<h3>Guten Tag ${escHtmlEmail(user.first_name)} ${escHtmlEmail(user.last_name)},</h3>
             <p>Sie wurden als Fachperson für DMSKI eingeladen.</p>
             <p>Login: <a href="https://dmski.aikmu.ch">https://dmski.aikmu.ch</a></p>`
    });

    res.json({ ok: true, message: "Email gesendet an " + user.email });
  } catch (err) {
    res.status(500).json({ error: "Mail-Versand Fehler: " + err.message });
  }
});

// DELETE /api/users/:userId (Benutzer löschen)
router.delete("/:userId", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id = $1 AND role != 'admin'", [req.params.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Löschen fehlgeschlagen" });
  }
});

module.exports = router;