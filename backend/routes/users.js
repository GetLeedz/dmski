const express = require("express");
const bcrypt = require("bcryptjs");
const { Resend } = require("resend");
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

const LOGIN_URL = "https://dmski.ch";
const FROM_ADDRESS = "DMSKI Scrutor <info@dmski.ch>";

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

async function sendEmail({ to, subject, html }) {
  const resend = getResend();
  if (!resend) {
    console.warn("[users] RESEND_API_KEY not set — email skipped");
    return;
  }
  await resend.emails.send({ from: FROM_ADDRESS, to: [to], subject, html });
  console.log(`[users] E-Mail gesendet an ${to}: ${subject}`);
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── DMSKI Scrutor Email Template ─────────────────────────────────────────
function buildEmail({ greeting, bodyHtml, showPwdChange = false }) {
  const warningBlock = showPwdChange ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(197,160,89,.08);border:1px solid rgba(197,160,89,.3);border-radius:10px;margin-bottom:24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0;font-size:13px;color:#96700a;line-height:1.5;">
          <strong>&#9888; Wichtig:</strong> Sie werden beim ersten Login aufgefordert, Ihr Passwort zu &auml;ndern.
          Bitte halten Sie Ihre Zugangsdaten streng vertraulich und leiten Sie diese E-Mail nicht weiter.
        </p>
      </td></tr>
    </table>` : "";

  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:40px 20px;">
<tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08);">

  <!-- Header -->
  <tr>
    <td style="background:#1A2B3C;padding:28px 40px;text-align:center;">
      <span style="color:#C5A059;font-size:13px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;">DMSKI SCRUTOR</span>
      <p style="color:rgba(255,255,255,.5);font-size:11px;margin:5px 0 0;letter-spacing:.03em;">KI-gest&uuml;tzte forensische Fallanalyse</p>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:36px 40px 32px;">
      <p style="color:#1A2B3C;font-size:15px;line-height:1.7;margin:0 0 24px;">${greeting}</p>
      ${bodyHtml}
      ${warningBlock}
      <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
        <tr><td style="background:#1A2B3C;border-radius:10px;text-align:center;">
          <a href="${LOGIN_URL}" style="display:inline-block;padding:14px 44px;color:#F8F9FA;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:.03em;">Zur forensischen Analyse &rarr;</a>
        </td></tr>
      </table>
      <p style="color:#8a96a3;font-size:12px;line-height:1.6;margin:0;text-align:center;">
        Bei Fragen: <a href="mailto:info@dmski.ch" style="color:#C5A059;text-decoration:none;">info@dmski.ch</a>
      </p>
    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#f5f6f8;border-top:1px solid #e8edf2;padding:24px 40px;text-align:center;">
      <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#1A2B3C;">DMSKI Scrutor &middot; GetLeedz GmbH</p>
      <p style="margin:0 0 4px;font-size:11px;color:#6b7b8a;">Walter F&uuml;rst-Strasse 1 &middot; CH-4102 Binningen &middot; Schweiz</p>
      <p style="margin:0;font-size:11px;color:#6b7b8a;">
        <a href="https://dmski.ch" style="color:#C5A059;text-decoration:none;">dmski.ch</a>
        &middot; <a href="mailto:info@dmski.ch" style="color:#C5A059;text-decoration:none;">info@dmski.ch</a>
      </p>
      <p style="margin:10px 0 0;font-size:10px;color:#a0adb8;">Diese Nachricht enth&auml;lt vertrauliche Informationen und ist ausschliesslich f&uuml;r den bezeichneten Empf&auml;nger bestimmt. Eine Weiterleitung oder Vervielf&auml;ltigung ist nicht gestattet.</p>
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
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border:1px solid #e2e8ef;border-radius:12px;overflow:hidden;margin-bottom:24px;">
  <tr><td style="padding:16px 24px;border-bottom:1px solid #e2e8ef;">
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:rgba(26,43,60,.5);text-transform:uppercase;letter-spacing:.08em;">Login-URL</p>
    <a href="${LOGIN_URL}" style="color:#C5A059;font-size:14px;font-weight:600;text-decoration:none;">${LOGIN_URL}</a>
  </td></tr>
  <tr><td style="padding:16px 24px;border-bottom:1px solid #e2e8ef;">
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:rgba(26,43,60,.5);text-transform:uppercase;letter-spacing:.08em;">Benutzername (E-Mail)</p>
    <span style="color:#1A2B3C;font-size:14px;font-weight:600;font-family:monospace;">${esc(email)}</span>
  </td></tr>
  <tr><td style="padding:16px 24px;">
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:rgba(26,43,60,.5);text-transform:uppercase;letter-spacing:.08em;">Tempor&auml;res Passwort</p>
    <span style="color:#1A2B3C;font-size:15px;font-weight:700;font-family:monospace;letter-spacing:.12em;">${esc(password)}</span>
  </td></tr>
</table>`;
}

function inviteOnlyTable(email) {
  return `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border:1px solid #e2e8ef;border-radius:12px;overflow:hidden;margin-bottom:24px;">
  <tr><td style="padding:16px 24px;border-bottom:1px solid #e2e8ef;">
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:rgba(26,43,60,.5);text-transform:uppercase;letter-spacing:.08em;">Login-URL</p>
    <a href="${LOGIN_URL}" style="color:#C5A059;font-size:14px;font-weight:600;text-decoration:none;">${LOGIN_URL}</a>
  </td></tr>
  <tr><td style="padding:16px 24px;">
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:rgba(26,43,60,.5);text-transform:uppercase;letter-spacing:.08em;">Benutzername (E-Mail)</p>
    <span style="color:#1A2B3C;font-size:14px;font-weight:600;font-family:monospace;">${esc(email)}</span>
  </td></tr>
</table>`;
}

function buildFormalGreeting(user) {
  const sal = (user.salutation || "").trim();
  const title = (user.academic_title || "").trim();
  const lastName = (user.last_name || "").trim();
  const titlePart = title ? ` ${esc(title)}` : "";
  if (sal && lastName) {
    return sal === "Frau"
      ? `Sehr geehrte Frau${titlePart} ${esc(lastName)}`
      : `Sehr geehrter Herr${titlePart} ${esc(lastName)}`;
  }
  const name = [title, user.first_name, user.last_name].filter(Boolean).join(" ");
  return name ? `Guten Tag ${esc(name)}` : "Guten Tag";
}

async function sendWelcomeEmail(user, password) {
  const greeting = buildFormalGreeting(user);
  const html = buildEmail({
    greeting: `${greeting},<br><br>
      Ihr pers&ouml;nlicher Zugang zu <strong>DMSKI Scrutor</strong> wurde eingerichtet &ndash; der forensischen KI-Plattform f&uuml;r die pr&auml;zise Analyse juristischer Aktenlagen.<br><br>
      Unsere KI durchleuchtet jedes Dokument Wort f&uuml;r Wort: Sie erkennt Widerspr&uuml;che, manipulative Darstellungsmuster und Inkonsistenzen, die bei manueller Pr&uuml;fung h&auml;ufig unentdeckt bleiben.<br><br>
      Nachfolgend Ihre Zugangsdaten f&uuml;r die gesch&uuml;tzte Analyseumgebung:`,
    bodyHtml: credentialsTable(user.email, password),
    showPwdChange: true,
  });
  await sendEmail({
    to: user.email,
    subject: `DMSKI Scrutor: Ihr Zugang zur forensischen Dossier-Analyse`,
    html,
  });
}

async function sendCredentialsUpdatedEmail(user, password) {
  const greeting = buildFormalGreeting(user);
  const html = buildEmail({
    greeting: `${greeting},<br><br>
      Ihre Zugangsdaten f&uuml;r <strong>DMSKI Scrutor</strong> wurden aktualisiert.
      Bitte verwenden Sie ab sofort die folgenden Anmeldedaten:`,
    bodyHtml: credentialsTable(user.email, password),
    showPwdChange: true,
  });
  await sendEmail({
    to: user.email,
    subject: "DMSKI Scrutor: Aktualisierte Zugangsdaten",
    html,
  });
}

async function sendInviteReminderEmail(user) {
  const greeting = buildFormalGreeting(user);
  const html = buildEmail({
    greeting: `${greeting},<br><br>
      Sie wurden zur forensischen Analyseplattform <strong>DMSKI Scrutor</strong> eingeladen.<br><br>
      DMSKI Scrutor ist ein KI-gest&uuml;tztes System f&uuml;r die Analyse komplexer Aktenlagen. Die forensische KI pr&uuml;ft jedes Dokument auf Widerspr&uuml;che, systematische Darstellungsmuster und unbelegte Behauptungen &ndash; und unterst&uuml;tzt damit die Wahrheitsfindung im Verfahren.<br><br>
      Ihre Analyseergebnisse stehen in einer gesch&uuml;tzten, vertraulichen Umgebung bereit. Sensible Prozessdaten verlassen zu keinem Zeitpunkt die gesicherte Infrastruktur.`,
    bodyHtml: inviteOnlyTable(user.email),
    showPwdChange: false,
  });
  await sendEmail({
    to: user.email,
    subject: "DMSKI Scrutor: Einladung zur forensischen Dossier-Analyse",
    html,
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /me
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, role, salutation, academic_title, first_name, last_name, function_label,
              case_id, mobile, address, password_change_required, tos_accepted_at
       FROM users WHERE id = $1`,
      [req.user.sub]
    );
    if (!result.rows.length) return res.status(404).json({ error: "User nicht gefunden" });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Profilfehler" });
  }
});

// POST /me/accept-tos – Record ToS acceptance timestamp
router.post("/me/accept-tos", requireAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE users SET tos_accepted_at = NOW() WHERE id = $1",
      [req.user.sub]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Speichern." });
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
      `SELECT id, email, role, salutation, academic_title, first_name, last_name, function_label, case_id, mobile
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
      `SELECT id, email, role, salutation, academic_title, first_name, last_name, function_label, case_id, mobile
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
  const { salutation, academic_title, first_name, last_name, email, mobile, function_label, case_id, password, role: newRole } = req.body;
  try {
    let result;
    if (password) {
      if (!validatePassword(password)) {
        return res.status(400).json({ error: "Passwort entspricht nicht den Anforderungen (min. 10 Zeichen, Gross-/Kleinbuchstaben, Zahl, Sonderzeichen)." });
      }
      const password_hash = await bcrypt.hash(password, 12);
      const effectiveRole = (newRole === "customer" || newRole === "collaborator") ? newRole : undefined;
      result = await pool.query(
        `UPDATE users SET salutation=$1, academic_title=$2, first_name=$3, last_name=$4, email=$5, mobile=$6, function_label=$7,
                case_id=$8, password_hash=$9, password_change_required=true
                ${effectiveRole ? `, role='${effectiveRole}'` : ""}
         WHERE id=$10 AND role != 'admin'
         RETURNING id, email, role, salutation, academic_title, first_name, last_name`,
        [salutation || null, academic_title || null, first_name || null, last_name || null, email, mobile || null, function_label || null, case_id || null, password_hash, req.params.userId]
      );
    } else {
      const effectiveRole = (newRole === "customer" || newRole === "collaborator") ? newRole : undefined;
      result = await pool.query(
        `UPDATE users SET salutation=$1, academic_title=$2, first_name=$3, last_name=$4, email=$5, mobile=$6, function_label=$7, case_id=$8
                ${effectiveRole ? `, role='${effectiveRole}'` : ""}
         WHERE id=$9 AND role != 'admin'
         RETURNING id, email, role, salutation, academic_title, first_name, last_name`,
        [salutation || null, academic_title || null, first_name || null, last_name || null, email, mobile || null, function_label || null, case_id || null, req.params.userId]
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

    // Check if user has a password set
    if (!user.password_hash) {
      return res.status(400).json({ error: "Bitte setzen Sie zuerst ein Passwort für diesen Benutzer (Bearbeiten → Passwort generieren)." });
    }

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
