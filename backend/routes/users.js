const express = require("express");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const { requireAuth, requireAdmin, requireAdminOrSelf } = require("../middleware/auth");
const { validatePassword } = require("../utils/passwordPolicy");

const router = express.Router();

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  const trimmed = String(rawUrl).trim().replace(/^['\"]|['\"]$/g, "").replace(/\s+/g, "");
  try { new URL(trimmed); return trimmed; } catch {
    const match = trimmed.match(/^(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@([^/]+)\/(.+)$/i);
    if (!match) return trimmed;
    const [, protocol, user, password, host, dbPath] = match;
    return `${protocol}${user}:${encodeURIComponent(password)}@${host}/${dbPath}`;
  }
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL) });

const LOGIN_URL = "https://dmski.aikmu.ch";
const FROM_ADDRESS = `"DMSKI Plattform" <${process.env.SMTP_USER || "dmski@aikmu.ch"}>`;

function createMailTransport() {
  return nodemailer.createTransport({
    host: "asmtp.mail.hostpoint.ch",
    port: 465,
    secure: true,
    auth: {
      user: process.env.SMTP_USER || "dmski@aikmu.ch",
      pass: process.env.SMTP_PASS,
    },
  });
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Swiss-style HTML Email Builder ───────────────────────────────────────────
function buildEmail({ greeting, bodyHtml, showPwdChange = false }) {
  const warningBlock = showPwdChange ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8e6;border:1.5px solid #f6cc6a;border-radius:10px;margin-bottom:24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0;font-size:13px;color:#7a5300;line-height:1.5;">
          <strong>&#9888; Wichtig:</strong> Sie werden beim ersten Login aufgefordert, Ihr Passwort zu ändern.
          Bitte halten Sie Ihre Zugangsdaten streng vertraulich und leiten Sie diese E-Mail nicht weiter.
        </p>
      </td></tr>
    </table>` : "";

  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f0f4f5;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f5;padding:40px 20px;">
<tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">

  <!-- Header -->
  <tr>
    <td style="background:linear-gradient(135deg,#0d5760 0%,#116b73 60%,#1a8a94 100%);padding:40px 40px 32px;text-align:center;">
      <div style="display:inline-block;background:rgba(255,255,255,.15);border-radius:12px;padding:12px 28px;border:1.5px solid rgba(255,255,255,.25);">
        <span style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">DMSKI</span>
      </div>
      <p style="color:rgba(255,255,255,.75);font-size:12px;margin:10px 0 0;letter-spacing:.04em;">Digitale Fallanalyse für Anwälte &amp; Gutachter</p>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:40px 40px 32px;">
      <p style="color:#4a6672;font-size:14px;line-height:1.7;margin:0 0 20px;">${greeting}</p>
      ${bodyHtml}
      ${warningBlock}
      <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
        <tr><td style="background:linear-gradient(135deg,#116b73,#0d5760);border-radius:10px;text-align:center;">
          <a href="${LOGIN_URL}" style="display:inline-block;padding:14px 36px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:.02em;">Jetzt anmelden &rarr;</a>
        </td></tr>
      </table>
      <p style="color:#8ba4b0;font-size:12px;line-height:1.6;margin:0;">
        Bei technischen Fragen wenden Sie sich bitte an
        <a href="mailto:info@getleedz.com" style="color:#116b73;text-decoration:none;">info@getleedz.com</a>.
      </p>
    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#f7fafb;border-top:1.5px solid #d5e5ec;padding:24px 40px;text-align:center;">
      <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#0a2330;">GetLeedz GmbH &middot; AiKMU</p>
      <p style="margin:0 0 4px;font-size:11px;color:#8ba4b0;">Walter F&uuml;rststr. 1 &middot; CH-4102 Binningen &middot; Schweiz</p>
      <p style="margin:0 0 4px;font-size:11px;color:#8ba4b0;">
        Tel: <a href="tel:+41615251810" style="color:#8ba4b0;text-decoration:none;">+41 61 525 18 10</a>
        &middot; <a href="mailto:info@getleedz.com" style="color:#8ba4b0;text-decoration:none;">info@getleedz.com</a>
      </p>
      <p style="margin:8px 0 0;font-size:10px;color:#b0c4cc;">MWST-Nr. CHE-339.044.174</p>
      <p style="margin:6px 0 0;font-size:10px;color:#b0c4cc;">Diese E-Mail enth&auml;lt vertrauliche Informationen. Bitte nicht weiterleiten.</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function credentialsTable(email, password) {
  return `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7fafb;border:1.5px solid #d5e5ec;border-radius:12px;overflow:hidden;margin-bottom:24px;">
  <tr><td style="padding:16px 24px;border-bottom:1px solid #d5e5ec;">
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:#116b73;text-transform:uppercase;letter-spacing:.06em;">Login-URL</p>
    <a href="${LOGIN_URL}" style="color:#116b73;font-size:14px;font-weight:600;text-decoration:none;">${LOGIN_URL}</a>
  </td></tr>
  <tr><td style="padding:16px 24px;border-bottom:1px solid #d5e5ec;">
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:#116b73;text-transform:uppercase;letter-spacing:.06em;">Benutzername (E-Mail)</p>
    <span style="color:#0a2330;font-size:14px;font-weight:600;font-family:monospace;">${esc(email)}</span>
  </td></tr>
  <tr><td style="padding:16px 24px;">
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:#116b73;text-transform:uppercase;letter-spacing:.06em;">Tempor&auml;res Passwort</p>
    <span style="color:#0a2330;font-size:15px;font-weight:700;font-family:monospace;letter-spacing:.12em;">${esc(password)}</span>
  </td></tr>
</table>`;
}

function inviteOnlyTable(email) {
  return `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7fafb;border:1.5px solid #d5e5ec;border-radius:12px;overflow:hidden;margin-bottom:24px;">
  <tr><td style="padding:16px 24px;border-bottom:1px solid #d5e5ec;">
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:#116b73;text-transform:uppercase;letter-spacing:.06em;">Login-URL</p>
    <a href="${LOGIN_URL}" style="color:#116b73;font-size:14px;font-weight:600;text-decoration:none;">${LOGIN_URL}</a>
  </td></tr>
  <tr><td style="padding:16px 24px;">
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:#116b73;text-transform:uppercase;letter-spacing:.06em;">Benutzername (E-Mail)</p>
    <span style="color:#0a2330;font-size:14px;font-weight:600;font-family:monospace;">${esc(email)}</span>
  </td></tr>
</table>`;
}

async function sendWelcomeEmail(user, password) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const salutation = name ? `, ${esc(name)}` : "";
  const html = buildEmail({
    greeting: `Sehr geehrte Damen und Herren${salutation},<br><br>
      Ihr Benutzerkonto auf der DMSKI-Plattform wurde erfolgreich eingerichtet.
      Nachfolgend finden Sie Ihre persönlichen Zugangsdaten:`,
    bodyHtml: credentialsTable(user.email, password),
    showPwdChange: true,
  });
  const transporter = createMailTransport();
  await transporter.sendMail({
    from: FROM_ADDRESS,
    to: user.email,
    subject: "Willkommen bei DMSKI – Ihre Zugangsdaten",
    html,
  });
}

async function sendCredentialsUpdatedEmail(user, password) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const salutation = name ? `, ${esc(name)}` : "";
  const html = buildEmail({
    greeting: `Sehr geehrte Damen und Herren${salutation},<br><br>
      Ihre Zugangsdaten für die DMSKI-Plattform wurden aktualisiert.
      Bitte verwenden Sie ab sofort das folgende temporäre Passwort:`,
    bodyHtml: credentialsTable(user.email, password),
    showPwdChange: true,
  });
  const transporter = createMailTransport();
  await transporter.sendMail({
    from: FROM_ADDRESS,
    to: user.email,
    subject: "DMSKI – Ihre Zugangsdaten wurden aktualisiert",
    html,
  });
}

async function sendInviteReminderEmail(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const salutation = name ? `, ${esc(name)}` : "";
  const html = buildEmail({
    greeting: `Sehr geehrte Damen und Herren${salutation},<br><br>
      Hiermit erhalten Sie eine Erinnerung zu Ihrem Benutzerkonto auf der DMSKI-Plattform.
      Ihr Benutzername ist Ihre E-Mail-Adresse. Sollten Sie Ihr Passwort nicht kennen,
      wenden Sie sich bitte an den Administrator.`,
    bodyHtml: inviteOnlyTable(user.email),
    showPwdChange: false,
  });
  const transporter = createMailTransport();
  await transporter.sendMail({
    from: FROM_ADDRESS,
    to: user.email,
    subject: "DMSKI – Erinnerung Ihrer Zugangsdaten",
    html,
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /me
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, role, first_name, last_name, function_label,
              case_id, mobile, address, password_change_required
       FROM users WHERE id = $1`,
      [req.user.sub]
    );
    if (!result.rows.length) return res.status(404).json({ error: "User nicht gefunden" });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Profilfehler" });
  }
});

// PATCH /me – Self-update (any authenticated user)
router.patch("/me", requireAuth, async (req, res) => {
  const { first_name, last_name, email, mobile, address, function_label, password, currentPassword } = req.body;
  try {
    if (password) {
      if (!currentPassword) return res.status(400).json({ error: "Aktuelles Passwort erforderlich." });
      if (!validatePassword(password)) return res.status(400).json({ error: "Neues Passwort entspricht nicht den Anforderungen (min. 10 Zeichen, Gross-/Kleinbuchstaben, Zahl, Sonderzeichen)." });

      const userRes = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user.sub]);
      if (!userRes.rows.length) return res.status(404).json({ error: "User nicht gefunden." });
      const match = await bcrypt.compare(String(currentPassword), userRes.rows[0].password_hash);
      if (!match) return res.status(401).json({ error: "Aktuelles Passwort ist falsch." });

      const password_hash = await bcrypt.hash(password, 12);
      const result = await pool.query(
        `UPDATE users SET first_name=$1, last_name=$2, email=$3, mobile=$4, address=$5,
                function_label=$6, password_hash=$7, password_change_required=false
         WHERE id=$8
         RETURNING id, email, role, first_name, last_name, mobile, address, function_label, password_change_required`,
        [first_name || null, last_name || null, email, mobile || null, address || null, function_label || null, password_hash, req.user.sub]
      );
      return res.json({ user: result.rows[0] });
    }

    const result = await pool.query(
      `UPDATE users SET first_name=$1, last_name=$2, email=$3, mobile=$4, address=$5, function_label=$6
       WHERE id=$7
       RETURNING id, email, role, first_name, last_name, mobile, address, function_label, password_change_required`,
      [first_name || null, last_name || null, email, mobile || null, address || null, function_label || null, req.user.sub]
    );
    if (!result.rows.length) return res.status(404).json({ error: "User nicht gefunden." });
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("PATCH /me error:", err.message);
    res.status(500).json({ error: "Profilaktualisierung fehlgeschlagen." });
  }
});

// GET / – Liste aller Benutzer (Admin only)
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, role, first_name, last_name, function_label, case_id, mobile
       FROM users ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Liste" });
  }
});

// GET /:userId/users – Fachpersonen für einen bestimmten Admin
router.get("/:userId/users", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, role, first_name, last_name, function_label, case_id, mobile
       FROM users WHERE role != 'admin' ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden" });
  }
});

// POST /:adminId/users – Neuen Benutzer anlegen (Admin only)
router.post("/:adminId/users", requireAuth, requireAdmin, async (req, res) => {
  const { first_name, last_name, email, mobile, function_label, case_id, password } = req.body;
  if (!email) return res.status(400).json({ error: "E-Mail ist erforderlich." });
  if (!password) return res.status(400).json({ error: "Passwort ist erforderlich." });
  if (!validatePassword(password)) {
    return res.status(400).json({ error: "Passwort entspricht nicht den Anforderungen (min. 10 Zeichen, Gross-/Kleinbuchstaben, Zahl, Sonderzeichen)." });
  }

  const emailNorm = String(email).trim().toLowerCase();
  const role = function_label ? "collaborator" : "customer";
  const password_hash = await bcrypt.hash(password, 12);

  try {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, mobile, function_label, case_id, password_change_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING id, email, role, first_name, last_name`,
      [emailNorm, password_hash, role, first_name || null, last_name || null, mobile || null, function_label || null, case_id || null]
    );

    const user = result.rows[0];

    try {
      await sendWelcomeEmail(user, password);
    } catch (mailErr) {
      console.error("Welcome email error:", mailErr.message);
    }

    res.status(201).json({ user });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Diese E-Mail-Adresse ist bereits registriert." });
    console.error("POST /:adminId/users error:", err.message);
    res.status(500).json({ error: "Benutzer konnte nicht angelegt werden." });
  }
});

// PATCH /:userId – Benutzer bearbeiten
router.patch("/:userId", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  const { first_name, last_name, email, mobile, function_label, case_id, password } = req.body;
  try {
    let result;
    if (password) {
      if (!validatePassword(password)) {
        return res.status(400).json({ error: "Passwort entspricht nicht den Anforderungen (min. 10 Zeichen, Gross-/Kleinbuchstaben, Zahl, Sonderzeichen)." });
      }
      const password_hash = await bcrypt.hash(password, 12);
      result = await pool.query(
        `UPDATE users SET first_name=$1, last_name=$2, email=$3, mobile=$4, function_label=$5,
                case_id=$6, password_hash=$7, password_change_required=true
         WHERE id=$8
         RETURNING id, email, role, first_name, last_name`,
        [first_name || null, last_name || null, email, mobile || null, function_label || null, case_id || null, password_hash, req.params.userId]
      );
    } else {
      result = await pool.query(
        `UPDATE users SET first_name=$1, last_name=$2, email=$3, mobile=$4, function_label=$5, case_id=$6
         WHERE id=$7
         RETURNING id, email, role, first_name, last_name`,
        [first_name || null, last_name || null, email, mobile || null, function_label || null, case_id || null, req.params.userId]
      );
    }

    if (!result.rows.length) return res.status(404).json({ error: "Benutzer nicht gefunden." });

    if (password) {
      try {
        await sendCredentialsUpdatedEmail(result.rows[0], password);
      } catch (mailErr) {
        console.error("Credentials email error:", mailErr.message);
      }
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("PATCH /users/:userId error:", err.message);
    res.status(500).json({ error: "Aktualisierung fehlgeschlagen." });
  }
});

// POST /:userId/users/:linkId/send-invite – Einladung erneut senden
router.post("/:userId/users/:linkId/send-invite", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  try {
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.linkId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "Empfänger nicht gefunden." });

    await sendInviteReminderEmail(user);
    res.json({ ok: true, message: "Einladung erfolgreich versendet." });
  } catch (err) {
    console.error("send-invite error:", err.message);
    res.status(500).json({ error: "Versand-Fehler: " + err.message });
  }
});

// DELETE /:userId
router.delete("/:userId", requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id = $1 AND role != 'admin'", [req.params.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Löschen fehlgeschlagen." });
  }
});

module.exports = router;
