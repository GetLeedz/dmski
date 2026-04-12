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

let trackingSchemaDone = false;
async function ensureTrackingSchema() {
  if (trackingSchemaDone) return;
  trackingSchemaDone = true;
  try {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ");
  } catch (err) {
    trackingSchemaDone = false;
    console.warn("Tracking schema info:", err.message);
  }
}

const LOGIN_URL = "https://dmski.ch";
const FROM_ADDRESS = "DMSKI <info@dmski.ch>";

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

// ── DMSKI Email Template ─────────────────────────────────────────
function buildEmail({ greeting, bodyHtml, showPwdChange = false }) {
  const warningBlock = showPwdChange ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(197,160,89,.08);border:1px solid rgba(197,160,89,.3);border-radius:10px;margin-bottom:24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0;font-size:13px;color:#96700a;line-height:1.5;">
          <strong>&#9888; Wichtig:</strong> Sie werden beim ersten Login aufgefordert, Ihr Passwort zu ändern.
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
    <td style="background:#1A2B3C;padding:32px 40px;text-align:center;">
      <img src="https://www.dmski.ch/assets/logo-dmski_gold.png" alt="DMSKI" width="140" style="display:inline-block;max-width:140px;height:auto;border:0;outline:none;text-decoration:none;" />
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
          <a href="${LOGIN_URL}" style="display:inline-block;padding:14px 44px;color:#F8F9FA;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:.03em;">LOGIN &rarr;</a>
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
      <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#1A2B3C;">DMSKI &middot; GetLeedz GmbH</p>
      <p style="margin:0 0 4px;font-size:11px;color:#6b7b8a;">Walter Fürst-Strasse 1 &middot; CH-4102 Binningen &middot; Schweiz</p>
      <p style="margin:0;font-size:11px;color:#6b7b8a;">
        <a href="https://dmski.ch" style="color:#C5A059;text-decoration:none;">dmski.ch</a>
        &middot; <a href="mailto:info@dmski.ch" style="color:#C5A059;text-decoration:none;">info@dmski.ch</a>
      </p>
      <p style="margin:10px 0 0;font-size:10px;color:#a0adb8;">Diese Nachricht enthält vertrauliche Informationen und ist ausschliesslich für den bezeichneten Empfänger bestimmt. Eine Weiterleitung oder Vervielfältigung ist nicht gestattet.</p>
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
    <p style="margin:0 0 5px;font-size:10px;font-weight:700;color:rgba(26,43,60,.5);text-transform:uppercase;letter-spacing:.08em;">Temporäres Passwort</p>
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
      Ihr persönlicher Zugang zu <strong>DMSKI</strong> wurde eingerichtet &ndash; der forensischen KI-Plattform für die präzise Analyse juristischer Aktenlagen.<br><br>
      Unsere KI durchleuchtet jedes Dokument Wort für Wort: Sie erkennt Widersprüche, manipulative Darstellungsmuster und Inkonsistenzen, die bei manueller Prüfung häufig unentdeckt bleiben.<br><br>
      Nachfolgend Ihre Zugangsdaten für die geschützte Analyseumgebung:`,
    bodyHtml: credentialsTable(user.email, password),
    showPwdChange: true,
  });
  await sendEmail({
    to: user.email,
    subject: `DMSKI: Ihr Zugang zur forensischen Dossier-Analyse`,
    html,
  });
}

async function sendCredentialsUpdatedEmail(user, password) {
  const greeting = buildFormalGreeting(user);
  const html = buildEmail({
    greeting: `${greeting},<br><br>
      Ihre Zugangsdaten für <strong>DMSKI</strong> wurden aktualisiert.
      Bitte verwenden Sie ab sofort die folgenden Anmeldedaten:`,
    bodyHtml: credentialsTable(user.email, password),
    showPwdChange: true,
  });
  await sendEmail({
    to: user.email,
    subject: "DMSKI: Aktualisierte Zugangsdaten",
    html,
  });
}

async function sendDossierAccessEmail(user, password, caseName) {
  const greeting = buildFormalGreeting(user);
  const caseRef = caseName ? esc(caseName) : "–";
  const caseBlock = caseName ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(26,43,60,.03);border:1px solid #e2e8ef;border-radius:10px;margin-bottom:20px;">
      <tr><td style="padding:14px 20px;">
        <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:rgba(26,43,60,.45);text-transform:uppercase;letter-spacing:.08em;">Fall-Referenz</p>
        <span style="color:#1A2B3C;font-size:15px;font-weight:700;">${caseRef}</span>
      </td></tr>
    </table>` : "";

  const html = buildEmail({
    greeting: `${greeting},<br><br>
      Ihnen wurde der Zugriff auf das digitale Dossier${caseName ? ` <strong>${caseRef}</strong>` : ""} auf der forensischen Analyseplattform <strong>DMSKI</strong> gewährt.<br><br>
      Die integrierte KI unterstützt Sie bei der Einordnung der Aktenlage: Sie strukturiert die vorliegenden Dokumente, prüft diese auf Widersprüche und systematische Darstellungsmuster und hebt relevante Indizien sowie potenzielle Inkonsistenzen direkt in der Übersicht hervor &ndash; um die Effizienz Ihrer Fallprüfung zu maximieren.<br><br>
      Sämtliche Prozessdaten werden in einer geschützten, vertraulichen Umgebung verarbeitet. Sensible Akteninhalte verlassen zu keinem Zeitpunkt die gesicherte Infrastruktur.<br><br>
      Nachfolgend Ihre Zugangsdaten:`,
    bodyHtml: caseBlock + credentialsTable(user.email, password),
    showPwdChange: true,
  });
  await sendEmail({
    to: user.email,
    subject: `DMSKI: Bereitstellung digitales Dossier & KI-Analyse${caseName ? ` – ${caseName}` : ""}`,
    html,
  });
}

async function sendCaseAccessEmail(user, caseName) {
  const greeting = buildFormalGreeting(user);
  const caseRef = caseName ? esc(caseName) : "";
  const caseBlock = caseName ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(26,43,60,.03);border:1px solid #e2e8ef;border-radius:10px;margin-bottom:20px;">
      <tr><td style="padding:14px 20px;">
        <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:rgba(26,43,60,.45);text-transform:uppercase;letter-spacing:.08em;">Fall-Referenz</p>
        <span style="color:#1A2B3C;font-size:15px;font-weight:700;">${caseRef}</span>
      </td></tr>
    </table>` : "";

  const html = buildEmail({
    greeting: `${greeting},<br><br>
      Sie wurden zum Dossier${caseName ? ` <strong>${caseRef}</strong>` : ""} auf <strong>DMSKI</strong> eingeladen.<br><br>
      Sie können sich mit Ihren bestehenden Zugangsdaten anmelden &ndash; Ihr Passwort wurde nicht geändert.`,
    bodyHtml: caseBlock + `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0;">
        <tr><td style="padding:14px 20px;background:#f0f4f8;border-radius:10px;text-align:center;">
          <a href="https://www.dmski.ch/login.html" style="color:#1A2B3C;font-weight:700;font-size:15px;text-decoration:none;">Jetzt anmelden &rarr;</a>
        </td></tr>
      </table>`,
    showPwdChange: false,
  });
  await sendEmail({
    to: user.email,
    subject: `DMSKI: Sie wurden zum Dossier eingeladen${caseName ? ` – ${caseName}` : ""}`,
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
  const { salutation, academic_title, first_name, last_name, email, mobile, address, function_label, password, currentPassword } = req.body;
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
      `UPDATE users SET salutation=$1, academic_title=$2, first_name=$3, last_name=$4, email=$5, mobile=$6, address=$7, function_label=$8
       WHERE id=$9
       RETURNING id, email, role, salutation, academic_title, first_name, last_name, mobile, address, function_label, password_change_required`,
      [salutation || null, academic_title || null, first_name || null, last_name || null, email, mobile || null, address || null, function_label || null, req.user.sub]
    );
    if (!result.rows.length) return res.status(404).json({ error: "User nicht gefunden." });
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("PATCH /me error:", err.message);
    res.status(500).json({ error: "Profilaktualisierung fehlgeschlagen." });
  }
});

// GET / – Liste aller Benutzer (Admin only) — inkl. gelöschte für Übersicht
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureTrackingSchema();
    const result = await pool.query(
      `SELECT id, email, role, salutation, academic_title, first_name, last_name, function_label, case_id, mobile, invited_at, last_login_at, login_count, deleted_at
       FROM users ORDER BY deleted_at ASC NULLS FIRST, created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Liste" });
  }
});

// GET /:userId/users – Fachpersonen für einen bestimmten Admin
router.get("/:userId/users", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  try {
    await ensureTrackingSchema();
    const userId = parseInt(req.params.userId, 10);

    // Admin sees all non-admin users (inkl. gelöschte für Übersicht)
    if (req.user.role === "admin") {
      const result = await pool.query(
        `SELECT id, email, role, salutation, academic_title, first_name, last_name, function_label, case_id, mobile, invited_at, last_login_at, login_count, deleted_at
         FROM users WHERE role != 'admin' ORDER BY deleted_at ASC NULLS FIRST, created_at DESC`
      );
      return res.json({ users: result.rows });
    }

    // Non-admin: only see themselves + team members on their own cases (keine gelöschten)
    const result = await pool.query(
      `SELECT DISTINCT u.id, u.email, u.role, u.salutation, u.academic_title, u.first_name, u.last_name, u.function_label, u.case_id, u.mobile, u.invited_at, u.last_login_at, u.login_count, u.deleted_at
       FROM users u
       WHERE u.deleted_at IS NULL
         AND (u.id = $1
          OR u.case_id IN (SELECT id FROM cases WHERE user_id = $1)
          OR u.id IN (
            SELECT cm.user_id FROM case_members cm
            JOIN cases c ON c.id = cm.case_id
            WHERE c.user_id = $1
          ))
       ORDER BY u.created_at DESC`,
      [userId]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error("GET /:userId/users error:", err.message);
    res.status(500).json({ error: "Fehler beim Laden" });
  }
});

// POST /:adminId/users – Neuen Benutzer anlegen (Admin or case owner)
router.post("/:adminId/users", requireAuth, async (req, res) => {
  const requesterId = req.user.id;
  const isAdmin = req.user.role === "admin";
  const isSelf = String(requesterId) === String(req.params.adminId);

  // Allow admin or case owner (customer adding team to their own case)
  if (!isAdmin && !isSelf) {
    return res.status(403).json({ error: "Keine Berechtigung." });
  }

  const { first_name, last_name, email, mobile, function_label, case_id, password } = req.body;
  if (!email) return res.status(400).json({ error: "E-Mail ist erforderlich." });
  if (!password) return res.status(400).json({ error: "Passwort ist erforderlich." });
  if (!validatePassword(password)) {
    return res.status(400).json({ error: "Passwort entspricht nicht den Anforderungen (min. 10 Zeichen, Gross-/Kleinbuchstaben, Zahl, Sonderzeichen)." });
  }

  // Non-admin: verify they own the case they're adding to
  if (!isAdmin && case_id) {
    try {
      const caseCheck = await pool.query("SELECT created_by FROM cases WHERE id = $1", [case_id]);
      if (!caseCheck.rows.length || String(caseCheck.rows[0].created_by) !== String(requesterId)) {
        return res.status(403).json({ error: "Sie können nur Teammitglieder zu Ihren eigenen Fällen hinzufügen." });
      }
    } catch (_) {
      return res.status(403).json({ error: "Fall konnte nicht geprüft werden." });
    }
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

function generateServerPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%&*+?";
  const all = upper + lower + digits + special;
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  const result = [pick(upper), pick(lower), pick(digits), pick(special)];
  for (let i = 4; i < 14; i++) result.push(pick(all));
  // Shuffle
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result.join("");
}

// POST /:userId/users/:linkId/send-invite – Einladung mit Zugangsdaten senden
router.post("/:userId/users/:linkId/send-invite", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  try {
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.linkId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "Empfänger nicht gefunden." });

    // Look up case name if assigned
    let caseName = "";
    if (user.case_id) {
      const caseRes = await pool.query("SELECT case_name FROM cases WHERE id = $1", [user.case_id]);
      caseName = caseRes.rows[0]?.case_name || String(user.case_id);
    }

    // Check if user has already logged in (existing active account)
    const hasLoggedIn = user.login_count > 0 && !user.password_change_required;

    if (hasLoggedIn) {
      // Existing user: send case-access email WITHOUT resetting password
      await pool.query("UPDATE users SET invited_at = NOW() WHERE id = $1", [user.id]);
      await sendCaseAccessEmail({ ...user }, caseName);
      res.json({ ok: true, message: "Einladung versendet (bestehendes Konto, Passwort unveraendert)." });
    } else {
      // New user or never logged in: generate fresh credentials
      const password = generateServerPassword();
      const password_hash = await bcrypt.hash(password, 12);
      await pool.query(
        "UPDATE users SET password_hash = $1, password_change_required = true, invited_at = NOW() WHERE id = $2",
        [password_hash, user.id]
      );
      await sendDossierAccessEmail({ ...user }, password, caseName);
      res.json({ ok: true, message: "Einladung mit Zugangsdaten erfolgreich versendet." });
    }
  } catch (err) {
    console.error("send-invite error:", err.message);
    res.status(500).json({ error: "Versand-Fehler: " + err.message });
  }
});

// DELETE /:userId — Soft-Delete: Admin löscht Benutzer (Zeile bleibt, deleted_at gesetzt)
router.delete("/:userId", requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureTrackingSchema();
    await pool.query(
      "UPDATE users SET deleted_at = NOW() WHERE id = $1 AND role != 'admin' AND deleted_at IS NULL",
      [req.params.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Löschen fehlgeschlagen." });
  }
});

// DELETE /me – Self-service account deletion (non-admin)
router.delete("/me/account", requireAuth, async (req, res) => {
  const userId = req.user.sub || req.user.id;
  const userRole = req.user.role;

  if (!userId) {
    return res.status(401).json({ error: "Keine gültige Benutzer-ID im Token." });
  }

  if (userRole === "admin") {
    return res.status(403).json({ error: "Admin-Konten können nicht selbst gelöscht werden." });
  }

  try {
    // Ensure deleted_at column exists before anything else
    await ensureTrackingSchema();

    // 1. Gather info about what will be deleted
    const info = { files: 0, cases: [], teamMembers: 0 };

    if (userRole === "customer") {
      // Count collaborators linked to this customer (team members that lose access).
      // Resilient: if customer_users table doesn't exist yet (fresh install), default to 0.
      try {
        const teamResult = await pool.query(
          "SELECT DISTINCT collaborator_id FROM customer_users WHERE customer_id = $1",
          [userId]
        );
        info.teamMembers = teamResult.rows.length;
      } catch (_) {
        info.teamMembers = 0;
      }

      // Count files across the case this user owns
      try {
        const userCase = await pool.query("SELECT case_id FROM users WHERE id = $1", [userId]);
        if (userCase.rows[0]?.case_id) {
          const fileCount = await pool.query(
            "SELECT COUNT(*) as cnt FROM case_documents WHERE case_id = $1",
            [userCase.rows[0].case_id]
          );
          info.files = Number(fileCount.rows[0]?.cnt || 0);
          info.cases.push(userCase.rows[0].case_id);
        }
      } catch (_) {
        // Schema not ready or user has no case — zero files
      }
    }

    // 2. If only requesting info (dry-run), return it
    if (req.query.dryrun === "true") {
      return res.json({ ok: true, info });
    }

    // 3. Actually delete
    if (userRole === "customer") {
      // Delete all cases owned by this customer (cascades to documents, analyses)
      const caseIds = info.cases;
      for (const cid of caseIds) {
        // Delete consolidated persons
        await pool.query("DELETE FROM case_consolidated_persons WHERE case_id = $1", [cid]).catch(() => {});
        // Delete forensic results
        await pool.query("DELETE FROM case_forensic_results WHERE case_id = $1", [cid]).catch(() => {});
        // Delete case (cascades to documents + analyses)
        await pool.query("DELETE FROM cases WHERE id = $1", [cid]);
      }
      // Delete team relationships (customer_users where I'm the customer)
      await pool.query("DELETE FROM customer_users WHERE customer_id = $1", [userId]).catch(() => {});
    }

    // For collaborators: remove from all teams
    if (userRole === "collaborator") {
      await pool.query("DELETE FROM customer_users WHERE collaborator_id = $1", [userId]).catch(() => {});
    }

    // Soft-Delete: Benutzerzeile bleibt für Admin-Übersicht erhalten,
    // Daten (Cases, Files, Team) wurden oben bereits hart gelöscht.
    const updateResult = await pool.query(
      "UPDATE users SET deleted_at = NOW() WHERE id = $1 AND role != 'admin' AND deleted_at IS NULL",
      [userId]
    );

    const rowsAffected = updateResult.rowCount || 0;
    console.log(`[self-delete] User ${userId} (${userRole}) soft-deleted. Rows affected: ${rowsAffected}`);

    if (rowsAffected === 0) {
      console.error(`[self-delete] UPDATE affected 0 rows for userId=${userId}. User may have been already deleted or role check failed.`);
      return res.status(500).json({ error: "Kontolöschung unvollständig — bitte Support kontaktieren." });
    }

    res.json({ ok: true, rowsAffected });
  } catch (err) {
    console.error("[self-delete] Error:", err.message);
    res.status(500).json({ error: "Kontolöschung fehlgeschlagen." });
  }
});

module.exports = router;
