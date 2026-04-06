/* backend/routes/audit.js – Audit-Log für Admin-Einsicht */
"use strict";

const express = require("express");
const { Pool } = require("pg");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  const trimmed = String(rawUrl).trim().replace(/^['\"]|['\"]$/g, "").replace(/\s+/g, "");
  try { new URL(trimmed); return trimmed; } catch { return trimmed; }
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL) });

/* ── Ensure table exists on first call ── */
let schemaDone = false;
async function ensureSchema() {
  if (schemaDone) return;
  schemaDone = true;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id         BIGSERIAL PRIMARY KEY,
        user_id    UUID,
        email      TEXT NOT NULL,
        action     TEXT NOT NULL,
        ip         TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user    ON audit_logs (user_id)`);
  } catch (err) {
    schemaDone = false;
    console.warn("audit schema:", err.message);
  }
}

/* ── Helper: write a log entry (called from auth route) ── */
async function writeLog({ userId, email, action, ip, userAgent }) {
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO audit_logs (user_id, email, action, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
      [userId || null, email, action, ip || null, userAgent || null]
    );
  } catch (err) {
    console.error("audit write error:", err.message);
  }
}

/* ── POST /audit/pageview – track page navigation (any authenticated user) ── */
router.post("/pageview", requireAuth, async (req, res) => {
  const { page } = req.body || {};
  if (!page) return res.status(400).json({ error: "page required" });
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
  await writeLog({
    userId: req.user.sub,
    email: req.user.email,
    action: `page:${String(page).substring(0, 60)}`,
    ip,
    userAgent: req.headers["user-agent"]
  });
  res.json({ ok: true });
});

/* ── GET /audit/logs – Admin only, paginated ── */
router.get("/logs", requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureSchema();
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const actionFilter = (req.query.action || "").trim();

    let where = "";
    const params = [limit, offset];
    if (actionFilter) {
      if (actionFilter.endsWith(":")) {
        where = ` WHERE l.action LIKE $3`;
        params.push(actionFilter + "%");
      } else {
        where = ` WHERE l.action = $3`;
        params.push(actionFilter);
      }
    }

    const { rows } = await pool.query(
      `SELECT l.id, l.email, l.action, l.ip, l.user_agent, l.created_at,
              u.first_name, u.last_name
       FROM audit_logs l
       LEFT JOIN users u ON u.id = l.user_id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    const countParams = actionFilter ? (actionFilter.endsWith(":") ? [actionFilter + "%"] : [actionFilter]) : [];
    const countWhere = actionFilter ? (actionFilter.endsWith(":") ? `WHERE action LIKE $1` : `WHERE action = $1`) : "";
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM audit_logs ${countWhere}`, countParams);
    res.json({ logs: rows, total: countResult.rows[0].total });
  } catch (err) {
    console.error("audit fetch error:", err.message);
    res.status(500).json({ error: "Fehler beim Laden der Logs." });
  }
});

module.exports = router;
module.exports.writeLog = writeLog;
