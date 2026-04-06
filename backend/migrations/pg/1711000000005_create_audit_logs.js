/* Migration: Create audit_logs table for admin session tracking */
"use strict";
const { Pool } = require("pg");

async function up() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id         BIGSERIAL PRIMARY KEY,
        user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
        email      TEXT NOT NULL,
        action     TEXT NOT NULL,
        ip         TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user    ON audit_logs (user_id)`);
    console.log("Migration: audit_logs table created.");
  } finally {
    await pool.end();
  }
}

if (require.main === module) up().catch(console.error);
module.exports = { up };
