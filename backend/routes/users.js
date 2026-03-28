const express = require("express");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const { requireAuth, requireAdmin, requireAdminOrSelf } = require("../middleware/auth");

const router = express.Router();

// Datenbank-Verbindung (Normalisiert für Railway)
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

// Mail-Konfiguration (Hostpoint)
function createMailTransport() {
  return nodemailer.createTransport({
    host: "asmtp.mail.hostpoint.ch",
    port: 465,
    secure: true,
    auth: {
      user: process.env.SMTP_USER || "dmski@aikmu.ch",
      pass: process.env.SMTP_PASS || "j+TqF5qsEqCS2d*&",
    },
  });
}

function escHtmlEmail(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- API ROUTEN ---

// GET /me - Das eigene Profil laden (WICHTIG für den Login-Check)
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, role, first_name, last_name, function_label, case_id FROM users WHERE id = $1",
      [req.user.sub]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "User nicht gefunden" });
    
    // Wir senden das Objekt flach zurück, damit das Frontend es sicher findet
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Profilfehler" });
  }
});

// GET / - Liste aller Benutzer (für Admins)
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, role, first_name, last_name, function_label, case_id FROM users ORDER BY created_at DESC"
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Liste" });
  }
});

// GET /:userId/users - Fachpersonen für einen bestimmten User/Admin laden
router.get("/:userId/users", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, role, first_name, last_name, function_label, case_id FROM users WHERE role = 'collaborator' ORDER BY created_at DESC"
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden" });
  }
});

// POST /:userId/users/:linkId/send-invite (DER E-MAIL VERSAND)
router.post("/:userId/users/:linkId/send-invite", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  try {
    const { linkId } = req.params;
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [linkId]);
    const user = userRes.rows[0];

    if (!user) return res.status(404).json({ error: "Empfänger nicht gefunden" });

    const transporter = createMailTransport();
    await transporter.sendMail({
      from: `"DMSKI Plattform" <${process.env.SMTP_USER || "dmski@aikmu.ch"}>`,
      to: user.email,
      subject: `Einladung zur DMSKI-Plattform`,
      html: `
        <div style="font-family: sans-serif; padding: 20px;">
          <h3>Guten Tag ${escHtmlEmail(user.first_name)} ${escHtmlEmail(user.last_name)},</h3>
          <p>Sie wurden als Fachperson eingeladen.</p>
          <p>Login: <a href="https://dmski.aikmu.ch">https://dmski.aikmu.ch</a></p>
          <p>Benutzername: ${user.email}</p>
        </div>`
    });

    res.json({ ok: true, message: "Email gesendet" });
  } catch (err) {
    res.status(500).json({ error: "Versand-Fehler: " + err.message });
  }
});

// PATCH /:userId – Benutzer bearbeiten
router.patch("/:userId", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  const { first_name, last_name, email, mobile, function_label, case_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users
       SET first_name = $1, last_name = $2, email = $3, mobile = $4,
           function_label = $5, case_id = $6
       WHERE id = $7
       RETURNING id, email, role, first_name, last_name, mobile, function_label, case_id`,
      [
        first_name || null,
        last_name || null,
        email,
        mobile || null,
        function_label || null,
        case_id || null,
        req.params.userId
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Benutzer nicht gefunden." });
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("PATCH /users/:userId error:", err.message);
    res.status(500).json({ error: "Aktualisierung fehlgeschlagen." });
  }
});

// DELETE /:userId
router.delete("/:userId", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id = $1 AND role != 'admin'", [req.params.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Löschen fehlgeschlagen" });
  }
});

module.exports = router;