/* Migration: Create credits system tables */
"use strict";
const { Pool } = require("pg");

async function up() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Credit settings (admin-configurable, singleton row)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_settings (
        id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        price_per_credit NUMERIC(10,2) NOT NULL DEFAULT 5.00,
        currency        TEXT NOT NULL DEFAULT 'CHF',
        free_signup_credits INTEGER NOT NULL DEFAULT 10,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      INSERT INTO credit_settings (id, price_per_credit, currency, free_signup_credits)
      VALUES (1, 5.00, 'CHF', 10)
      ON CONFLICT (id) DO NOTHING
    `);

    // User credit balances
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_credits (
        user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        balance          INTEGER NOT NULL DEFAULT 0,
        total_purchased  INTEGER NOT NULL DEFAULT 0,
        total_spent      INTEGER NOT NULL DEFAULT 0,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Credit transactions log
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id              BIGSERIAL PRIMARY KEY,
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type            TEXT NOT NULL CHECK (type IN ('purchase','signup_bonus','deduct','admin_grant','refund')),
        amount          INTEGER NOT NULL,
        balance_after   INTEGER NOT NULL,
        description     TEXT,
        stripe_session_id TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions (user_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_tx_stripe ON credit_transactions (stripe_session_id) WHERE stripe_session_id IS NOT NULL`);

    // Credit packages (what users can buy)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_packages (
        id              SERIAL PRIMARY KEY,
        name            TEXT NOT NULL,
        credits         INTEGER NOT NULL,
        price           NUMERIC(10,2) NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'CHF',
        popular         BOOLEAN NOT NULL DEFAULT false,
        active          BOOLEAN NOT NULL DEFAULT true,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Default packages
    await pool.query(`
      INSERT INTO credit_packages (name, credits, price, popular, sort_order) VALUES
        ('Starter',      50,   250.00,  false, 1),
        ('Standard',    150,   675.00,  true,  2),
        ('Professional', 500,  2000.00, false, 3)
      ON CONFLICT DO NOTHING
    `);

    // Email verification fields on users
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMPTZ`);

    console.log("Migration: credits system tables created.");
  } finally {
    await pool.end();
  }
}

if (require.main === module) up().catch(console.error);
module.exports = { up };
