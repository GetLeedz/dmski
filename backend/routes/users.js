const express = require("express");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const { requireAuth, requireAdmin, requireAdminOrSelf } = require("../middleware/auth");

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

// ── SMTP mail transport ────────────────────────────────────────────────────
function createMailTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || "asmtp.mail.hostpoint.ch",
    port:   Number(process.env.SMTP_PORT || 465),
    secure: true, // SSL on port 465
    auth: {
      user: process.env.SMTP_USER || "dmski@aikmu.ch",
      pass: process.env.SMTP_PASS || "j+TqF5qsEqCS2d*&",
    },
  });
}

// ── HTML invite email template ─────────────────────────────────────────────
function buildInviteEmail({ inviteeName, inviteeEmail, customerName, functionLabel, platformUrl }) {
  const displayName = inviteeName || inviteeEmail;
  const fn = functionLabel || "Fachperson";
  const url = platformUrl || "https://dmski.aikmu.ch";
  return {
    subject: `Einladung zur DMSKI-Plattform – ${customerName || "Fallteam"}`,
    html: `<!doctype html>
<html lang="de">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Einladung DMSKI</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f6;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f6;padding:40px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10)">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#0d5760 0%,#116b73 50%,#1a8a94 100%);padding:36px 40px 30px;text-align:center">
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:800;letter-spacing:-0.5px">DMSKI</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px;letter-spacing:0.5px">Dokument-Management &amp; Sachverständigen-Koordination</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px 28px">
            <p style="margin:0 0 10px;font-size:17px;font-weight:700;color:#0f2b36">Guten Tag, ${escHtmlEmail(displayName)}</p>
            <p style="margin:0 0 22px;font-size:15px;color:#2d4a56;line-height:1.65">
              Sie wurden als <strong>${escHtmlEmail(fn)}</strong> zum Fallteam von
              <strong>${escHtmlEmail(customerName || "DMSKI")}</strong> eingeladen
              und erhalten damit Lesezugriff auf die relevanten Falldokumente.
            </p>

            <!-- Info box -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
              <tr>
                <td style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:18px 22px">
                  <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:0.06em">Ihre Zugangsdaten</p>
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="font-size:13px;color:#64748b;padding-right:10px;padding-bottom:4px">Plattform:</td>
                      <td style="font-size:13px;color:#0f2b36;font-weight:600;padding-bottom:4px">
                        <a href="${url}" style="color:#116b73;text-decoration:none">${url}</a>
                      </td>
                    </tr>
                    <tr>
                      <td style="font-size:13px;color:#64748b;padding-right:10px;padding-bottom:4px">Login (E-Mail):</td>
                      <td style="font-size:13px;color:#0f2b36;font-weight:600;padding-bottom:4px">${escHtmlEmail(inviteeEmail)}</td>
                    </tr>
                    <tr>
                      <td style="font-size:13px;color:#64748b;padding-right:10px">Passwort:</td>
                      <td style="font-size:13px;color:#64748b">Wurde Ihnen separat mitgeteilt</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- CTA button -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
              <tr>
                <td align="center">
                  <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#116b73,#0d5760);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:13px 36px;border-radius:10px;box-shadow:0 4px 14px rgba(17,107,115,0.30)">
                    Zur Plattform →
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:0;font-size:13px;color:#8ba4b0;line-height:1.6">
              Bei Fragen stehen wir Ihnen gerne zur Verfügung.<br/>
              Diese E-Mail wurde automatisch von der DMSKI-Plattform versandt.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f7fbfc;border-top:1px solid #dae2e8;padding:18px 40px;text-align:center">
            <p style="margin:0;font-size:12px;color:#8ba4b0">
              © ${new Date().getFullYear()} DMSKI · <a href="${url}/impressum.html" style="color:#116b73;text-decoration:none">Impressum</a> · <a href="${url}/datenschutz.html" style="color:#116b73;text-decoration:none">Datenschutz</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
    text: `Guten Tag ${displayName},\n\nSie wurden als ${fn} zum Fallteam von ${customerName || "DMSKI"} eingeladen.\n\nPlattform: ${url}\nLogin: ${inviteeEmail}\nPasswort: Wurde Ihnen separat mitgeteilt\n\nBei Fragen stehen wir Ihnen gerne zur Verfügung.\n\nDMSKI-Team`
  };
}

function escHtmlEmail(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Schema migration: ensure profile columns exist ─────────────────────────
let userProfileSchemaDone = false;
async function ensureUserProfileColumns() {
  if (userProfileSchemaDone) return;
  try {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'customer'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile TEXT");
    userProfileSchemaDone = true;
  } catch (err) {
    console.warn("ensureUserProfileColumns warning:", err.message);
  }
}

// ── Schema migration for customer_collaborators table ──────────────────────
let collabSchemaDone = false;
async function ensureCollabSchema() {
  if (collabSchemaDone) return;
  // Create table if it doesn't exist yet
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_collaborators (
      id              SERIAL PRIMARY KEY,
      customer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      collaborator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      function_label  TEXT,
      case_id         TEXT,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (customer_id, collaborator_id)
    )
  `);
  // Add case_id column to existing tables that were created before this migration
  try {
    await pool.query(`ALTER TABLE customer_collaborators ADD COLUMN IF NOT EXISTS case_id TEXT`);
  } catch (colErr) {
    console.warn("case_id column migration:", colErr.message);
  }
  collabSchemaDone = true;
}

// ── Password generator ─────────────────────────────────────────────────────
function generatePassword() {
  const upper   = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower   = "abcdefghjkmnpqrstuvwxyz";
  const digits  = "23456789";
  const special = "!@#$%&*";
  const all     = upper + lower + digits + special;
  let pwd = upper[Math.floor(Math.random() * upper.length)]
          + lower[Math.floor(Math.random() * lower.length)]
          + digits[Math.floor(Math.random() * digits.length)]
          + special[Math.floor(Math.random() * special.length)];
  for (let i = 4; i < 14; i++) {
    pwd += all[Math.floor(Math.random() * all.length)];
  }
  const arr = pwd.split("");
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}

// ── GET /users/me ──────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  try {
    await ensureUserProfileColumns();
    const result = await pool.query(
      `SELECT id, email, role, first_name, last_name, address, mobile, created_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [req.user.sub]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Benutzer nicht gefunden." });

    const user = { ...result.rows[0], function_label: null };

    // Try to fetch function_label from collaborator link (table may not exist yet)
    try {
      await ensureCollabSchema();
      const ccResult = await pool.query(
        `SELECT function_label FROM customer_collaborators WHERE collaborator_id = $1 LIMIT 1`,
        [req.user.sub]
      );
      if (ccResult.rows[0]) user.function_label = ccResult.rows[0].function_label;
    } catch (ccErr) {
      console.warn("function_label lookup skipped:", ccErr.message);
    }

    return res.json({ user });
  } catch (err) {
    console.error("Get me error:", err.message);
    return res.status(500).json({ error: "Profil konnte nicht geladen werden." });
  }
});

// ── PATCH /users/me ────────────────────────────────────────────────────────
router.patch("/me", requireAuth, async (req, res) => {
  const { email, password, currentPassword, first_name, last_name, address, mobile, function_label } = req.body;
  await ensureUserProfileColumns();
  try {
    await ensureCollabSchema();
  } catch (err) {
    console.warn("ensureCollabSchema on PATCH /me:", err.message);
  }
  try {
    if (password) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Aktuelles Passwort erforderlich zum Ändern." });
      }
      const row = await pool.query(
        "SELECT password_hash FROM users WHERE id = $1 LIMIT 1",
        [req.user.sub]
      );
      const match = await bcrypt.compare(currentPassword, row.rows[0]?.password_hash || "");
      if (!match) return res.status(401).json({ error: "Aktuelles Passwort ist falsch." });
      if (password.length < 8) {
        return res.status(400).json({ error: "Neues Passwort muss mindestens 8 Zeichen haben." });
      }
      const newHash = await bcrypt.hash(password, 12);
      await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [newHash, req.user.sub]);
    }

    const updates = {};
    if (email) updates.email = String(email).trim().toLowerCase();
    if (first_name !== undefined) updates.first_name = String(first_name || "").trim() || null;
    if (last_name  !== undefined) updates.last_name  = String(last_name  || "").trim() || null;
    if (address    !== undefined) updates.address    = String(address    || "").trim() || null;
    if (mobile     !== undefined) updates.mobile     = String(mobile     || "").trim() || null;

    if (Object.keys(updates).length > 0) {
      const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(", ");
      await pool.query(
        `UPDATE users SET ${setClauses} WHERE id = $1`,
        [req.user.sub, ...Object.values(updates)]
      );
    }

    if (function_label !== undefined) {
      await pool.query(
        `UPDATE customer_collaborators SET function_label = $1 WHERE collaborator_id = $2`,
        [String(function_label || "").trim() || null, req.user.sub]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "E-Mail bereits vergeben." });
    console.error("Patch me error:", err.message);
    return res.status(500).json({ error: "Profil konnte nicht aktualisiert werden." });
  }
});

// ── GET /users  (admin only) ───────────────────────────────────────────────
router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureUserProfileColumns();
    await ensureCollabSchema().catch(() => {}); // ignore if table absent
    const result = await pool.query(
      `SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.address, u.mobile, u.created_at,
              (SELECT cc.function_label FROM customer_collaborators cc WHERE cc.collaborator_id = u.id LIMIT 1) AS function_label,
              (SELECT cc.case_id        FROM customer_collaborators cc WHERE cc.collaborator_id = u.id LIMIT 1) AS case_id
       FROM users u
       ORDER BY u.created_at ASC`
    );
    return res.json({ users: result.rows });
  } catch (err) {
    console.error("List users error:", err.message);
    return res.status(500).json({ error: "Benutzerliste konnte nicht geladen werden." });
  }
});

// ── POST /users/customers  (admin only – create new customer) ──────────────
router.post("/customers", requireAuth, requireAdmin, async (req, res) => {
  const { email, first_name, last_name, address, mobile } = req.body;
  if (!email) return res.status(400).json({ error: "E-Mail erforderlich." });
  const emailNorm = String(email).trim().toLowerCase();
  const rawPassword = generatePassword();

  try {
    const exists = await pool.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1", [emailNorm]
    );
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: "E-Mail bereits registriert." });
    }
    const hash = await bcrypt.hash(rawPassword, 12);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, address, mobile)
       VALUES ($1, $2, 'customer', $3, $4, $5, $6)
       RETURNING id, email, role, first_name, last_name, address, mobile, created_at`,
      [emailNorm, hash,
       first_name || null, last_name || null,
       address || null, mobile || null]
    );
    return res.status(201).json({
      user: result.rows[0],
      generatedPassword: rawPassword
    });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "E-Mail bereits registriert." });
    console.error("Create customer error:", err.message);
    return res.status(500).json({ error: "Kunde konnte nicht erstellt werden." });
  }
});

// ── GET /users/:userId/collaborators ──────────────────────────────────────
router.get("/:userId/collaborators", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  const customerId = Number(req.params.userId);
  try {
    await ensureCollabSchema();
    const result = await pool.query(
      `SELECT cc.id, cc.function_label, cc.case_id, cc.created_at,
              u.id AS user_id, u.email, u.first_name, u.last_name, u.role,
              c.case_name
       FROM customer_collaborators cc
       JOIN users u ON u.id = cc.collaborator_id
       LEFT JOIN cases c ON c.id = cc.case_id
       WHERE cc.customer_id = $1
       ORDER BY cc.created_at ASC`,
      [customerId]
    );
    return res.json({ collaborators: result.rows });
  } catch (err) {
    console.error("List collabs error:", err.message);
    return res.status(500).json({ error: "Fachpersonenliste konnte nicht geladen werden." });
  }
});

// ── POST /users/:userId/collaborators ─────────────────────────────────────
router.post("/:userId/collaborators", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  const customerId = Number(req.params.userId);
  const { email, function_label, first_name, last_name, case_id } = req.body;
  if (!email) return res.status(400).json({ error: "E-Mail erforderlich." });
  const emailNorm = String(email).trim().toLowerCase();
  const firstNorm = String(first_name || "").trim() || null;
  const lastNorm  = String(last_name  || "").trim() || null;

  try {
    await ensureUserProfileColumns();
    await ensureCollabSchema();

    let collaboratorId;
    let generatedPassword = null;

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1", [emailNorm]
    );
    if (existing.rows.length > 0) {
      collaboratorId = existing.rows[0].id;
      if (firstNorm || lastNorm) {
        await pool.query(
          `UPDATE users SET
             first_name = COALESCE(NULLIF(first_name,''), $2),
             last_name  = COALESCE(NULLIF(last_name, ''), $3)
           WHERE id = $1`,
          [collaboratorId, firstNorm, lastNorm]
        );
      }
    } else {
      const rawPassword = generatePassword();
      generatedPassword = rawPassword;
      const hash = await bcrypt.hash(rawPassword, 12);
      const created = await pool.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name)
         VALUES ($1, $2, 'collaborator', $3, $4) RETURNING id`,
        [emailNorm, hash, firstNorm, lastNorm]
      );
      collaboratorId = created.rows[0].id;
    }

    const linkResult = await pool.query(
      `INSERT INTO customer_collaborators (customer_id, collaborator_id, function_label, case_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (customer_id, collaborator_id)
       DO UPDATE SET function_label = EXCLUDED.function_label, case_id = EXCLUDED.case_id
       RETURNING id`,
      [customerId, collaboratorId, function_label || null, case_id || null]
    );

    const userRow = await pool.query(
      "SELECT id, email, role, first_name, last_name FROM users WHERE id = $1 LIMIT 1",
      [collaboratorId]
    );

    return res.status(201).json({
      collaborator: { ...userRow.rows[0], function_label: function_label || null, case_id: case_id || null },
      linkId: linkResult.rows[0].id,
      generatedPassword,
      isNewUser: generatedPassword !== null
    });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Fachperson bereits verknüpft." });
    console.error("Add collab error:", err.message);
    return res.status(500).json({ error: "Fachperson konnte nicht hinzugefügt werden." });
  }
});

// ── POST /users/:userId/collaborators/:linkId/send-invite ──────────────────
router.post("/:userId/collaborators/:linkId/send-invite", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  const customerId = Number(req.params.userId);
  const linkId     = Number(req.params.linkId);

  try {
    await ensureCollabSchema();

    // Fetch link + collaborator details
    const linkRow = await pool.query(
      `SELECT cc.id, cc.function_label,
              u.email, u.first_name, u.last_name
       FROM customer_collaborators cc
       JOIN users u ON u.id = cc.collaborator_id
       WHERE cc.id = $1 AND cc.customer_id = $2
       LIMIT 1`,
      [linkId, customerId]
    );
    if (!linkRow.rows[0]) {
      return res.status(404).json({ error: "Fachperson nicht gefunden." });
    }
    const collab = linkRow.rows[0];

    // Fetch customer name
    const custRow = await pool.query(
      "SELECT first_name, last_name, email FROM users WHERE id = $1 LIMIT 1",
      [customerId]
    );
    const cust = custRow.rows[0] || {};
    const customerName = [cust.first_name, cust.last_name].filter(Boolean).join(" ") || cust.email || "DMSKI";
    const inviteeName  = [collab.first_name, collab.last_name].filter(Boolean).join(" ") || "";

    const { subject, html, text } = buildInviteEmail({
      inviteeName,
      inviteeEmail:   collab.email,
      customerName,
      functionLabel:  collab.function_label,
      platformUrl:    process.env.PLATFORM_URL || "https://dmski.aikmu.ch",
    });

    const transport = createMailTransport();
    await transport.sendMail({
      from:    `"DMSKI Plattform" <${process.env.SMTP_USER || "dmski@aikmu.ch"}>`,
      to:      collab.email,
      subject,
      html,
      text,
    });

    return res.json({ ok: true, sentTo: collab.email });
  } catch (err) {
    console.error("Send invite error:", err.message);
    return res.status(500).json({ error: `Einladung konnte nicht gesendet werden: ${err.message}` });
  }
});

// ── PATCH /users/:userId  (admin OR customer who has this as collaborator) ─
router.patch("/:userId", requireAuth, async (req, res) => {
  const userId      = Number(req.params.userId);
  const requesterId = Number(req.user.sub);
  const requesterRole = req.user.role;
  if (!userId) return res.status(400).json({ error: "Ungültige ID." });

  // Authorization check
  if (requesterRole !== "admin") {
    if (requesterRole !== "customer") return res.status(403).json({ error: "Nicht autorisiert." });
    try {
      await ensureCollabSchema();
      const link = await pool.query(
        "SELECT id FROM customer_collaborators WHERE customer_id=$1 AND collaborator_id=$2 LIMIT 1",
        [requesterId, userId]
      );
      if (link.rows.length === 0) return res.status(403).json({ error: "Nicht autorisiert." });
    } catch (err) {
      return res.status(500).json({ error: "Berechtigungsprüfung fehlgeschlagen." });
    }
  }

  const { email, first_name, last_name, role, address, mobile, function_label, case_id } = req.body;
  // Ensure both schemas exist before any UPDATE
  try { await ensureUserProfileColumns(); } catch (e) { console.warn("ensureUserProfileColumns in PATCH /:userId:", e.message); }
  try { await ensureCollabSchema(); }        catch (e) { console.warn("ensureCollabSchema in PATCH /:userId:", e.message); }
  try {
    // Update user record
    const updates = {};
    if (email      !== undefined) updates.email      = String(email      || "").trim().toLowerCase();
    if (first_name !== undefined) updates.first_name = String(first_name || "").trim() || null;
    if (last_name  !== undefined) updates.last_name  = String(last_name  || "").trim() || null;
    if (address    !== undefined) updates.address    = String(address    || "").trim() || null;
    if (mobile     !== undefined) updates.mobile     = String(mobile     || "").trim() || null;
    if (role !== undefined && ["customer","collaborator"].includes(role)) updates.role = role;

    if (Object.keys(updates).length > 0) {
      const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(", ");
      await pool.query(`UPDATE users SET ${setClauses} WHERE id = $1 AND role != 'admin'`,
        [userId, ...Object.values(updates)]);
    }

    // Also update collaborator link fields (function_label, case_id) if provided
    if ((function_label !== undefined || case_id !== undefined) && requesterRole !== "admin") {
      const linkUpd = {};
      if (function_label !== undefined) linkUpd.function_label = String(function_label || "").trim() || null;
      if (case_id        !== undefined) linkUpd.case_id        = String(case_id        || "").trim() || null;
      if (Object.keys(linkUpd).length > 0) {
        const sc = Object.keys(linkUpd).map((k, i) => `${k}=$${i+3}`).join(", ");
        await pool.query(`UPDATE customer_collaborators SET ${sc} WHERE customer_id=$1 AND collaborator_id=$2`,
          [requesterId, userId, ...Object.values(linkUpd)]);
      }
    } else if ((function_label !== undefined || case_id !== undefined) && requesterRole === "admin") {
      const linkUpd = {};
      if (function_label !== undefined) linkUpd.function_label = String(function_label || "").trim() || null;
      if (case_id        !== undefined) linkUpd.case_id        = String(case_id        || "").trim() || null;
      if (Object.keys(linkUpd).length > 0) {
        const sc = Object.keys(linkUpd).map((k, i) => `${k}=$${i+2}`).join(", ");
        await pool.query(`UPDATE customer_collaborators SET ${sc} WHERE collaborator_id=$1`, [userId, ...Object.values(linkUpd)]);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "E-Mail bereits vergeben." });
    console.error("Patch user error:", err.message);
    return res.status(500).json({ error: "Benutzer konnte nicht aktualisiert werden." });
  }
});

// ── DELETE /users/:userId  (admin – delete any non-admin user) ─────────────
router.delete("/:userId", requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ error: "Ungültige ID." });
  try {
    const result = await pool.query(
      "DELETE FROM users WHERE id = $1 AND role != 'admin' RETURNING id", [userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Benutzer nicht gefunden oder kann nicht gelöscht werden." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete user error:", err.message);
    return res.status(500).json({ error: "Benutzer konnte nicht gelöscht werden." });
  }
});

// ── DELETE /users/:userId/collaborators/:linkId ────────────────────────────
router.delete("/:userId/collaborators/:linkId", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  const customerId = Number(req.params.userId);
  const linkId     = Number(req.params.linkId);
  try {
    await ensureCollabSchema();
    await pool.query(
      "DELETE FROM customer_collaborators WHERE id = $1 AND customer_id = $2",
      [linkId, customerId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("Remove collab error:", err.message);
    return res.status(500).json({ error: "Fachperson konnte nicht entfernt werden." });
  }
});

module.exports = router;
