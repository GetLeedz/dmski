const express = require("express");
const bcrypt = require("bcryptjs");
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

// ── Schema migration for customer_collaborators table ──────────────────────
let collabSchemaDone = false;
async function ensureCollabSchema() {
  if (collabSchemaDone) return;
  collabSchemaDone = true;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_collaborators (
        id         SERIAL PRIMARY KEY,
        customer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        collaborator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        function_label TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (customer_id, collaborator_id)
      )
    `);
  } catch (err) {
    collabSchemaDone = false;
    console.warn("Collab schema warning:", err.message);
  }
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
  // Fisher-Yates shuffle
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
    const result = await pool.query(
      `SELECT id, email, role, first_name, last_name, address, mobile, created_at
       FROM users WHERE id = $1 LIMIT 1`,
      [req.user.sub]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Benutzer nicht gefunden." });
    return res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("Get me error:", err.message);
    return res.status(500).json({ error: "Profil konnte nicht geladen werden." });
  }
});

// ── PATCH /users/me ────────────────────────────────────────────────────────
router.patch("/me", requireAuth, async (req, res) => {
  const { email, password, currentPassword, first_name, last_name, address, mobile } = req.body;
  try {
    // Password change requires currentPassword verification
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

    // Build profile field updates
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
    const result = await pool.query(
      `SELECT id, email, role, first_name, last_name, address, mobile, created_at
       FROM users ORDER BY created_at ASC`
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
  await ensureCollabSchema();
  try {
    const result = await pool.query(
      `SELECT cc.id, cc.function_label, cc.created_at,
              u.id AS user_id, u.email, u.first_name, u.last_name, u.role
       FROM customer_collaborators cc
       JOIN users u ON u.id = cc.collaborator_id
       WHERE cc.customer_id = $1
       ORDER BY cc.created_at ASC`,
      [customerId]
    );
    return res.json({ collaborators: result.rows });
  } catch (err) {
    console.error("List collabs error:", err.message);
    return res.status(500).json({ error: "Mitarbeiterliste konnte nicht geladen werden." });
  }
});

// ── POST /users/:userId/collaborators ─────────────────────────────────────
// Adds a collaborator (creates user if email not yet registered)
router.post("/:userId/collaborators", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  const customerId = Number(req.params.userId);
  const { email, function_label } = req.body;
  if (!email) return res.status(400).json({ error: "E-Mail erforderlich." });
  const emailNorm = String(email).trim().toLowerCase();
  await ensureCollabSchema();

  try {
    let collaboratorId;
    let generatedPassword = null;

    // Find or create the collaborator user
    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1", [emailNorm]
    );
    if (existing.rows.length > 0) {
      collaboratorId = existing.rows[0].id;
    } else {
      const rawPassword = generatePassword();
      generatedPassword = rawPassword;
      const hash = await bcrypt.hash(rawPassword, 12);
      const created = await pool.query(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, 'collaborator') RETURNING id`,
        [emailNorm, hash]
      );
      collaboratorId = created.rows[0].id;
    }

    // Link to customer
    const linkResult = await pool.query(
      `INSERT INTO customer_collaborators (customer_id, collaborator_id, function_label)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, collaborator_id)
       DO UPDATE SET function_label = EXCLUDED.function_label
       RETURNING id`,
      [customerId, collaboratorId, function_label || null]
    );

    const userRow = await pool.query(
      "SELECT id, email, role, first_name, last_name FROM users WHERE id = $1 LIMIT 1",
      [collaboratorId]
    );

    return res.status(201).json({
      collaborator: { ...userRow.rows[0], function_label: function_label || null },
      linkId: linkResult.rows[0].id,
      generatedPassword,
      isNewUser: generatedPassword !== null
    });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Mitarbeiter bereits verknüpft." });
    console.error("Add collab error:", err.message);
    return res.status(500).json({ error: "Mitarbeiter konnte nicht hinzugefügt werden." });
  }
});

// ── DELETE /users/:userId/collaborators/:linkId ────────────────────────────
router.delete("/:userId/collaborators/:linkId", requireAuth, requireAdminOrSelf("userId"), async (req, res) => {
  const customerId = Number(req.params.userId);
  const linkId     = Number(req.params.linkId);
  await ensureCollabSchema();
  try {
    await pool.query(
      "DELETE FROM customer_collaborators WHERE id = $1 AND customer_id = $2",
      [linkId, customerId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("Remove collab error:", err.message);
    return res.status(500).json({ error: "Mitarbeiter konnte nicht entfernt werden." });
  }
});

module.exports = router;
