/**
 * Admin seed script
 * Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/seedAdmin.js
 *
 * Or set values in .env:
 *   ADMIN_EMAIL=your@email.com
 *   ADMIN_PASSWORD=YourPassword123!
 */
require("dotenv").config();

const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { validatePassword } = require("../utils/passwordPolicy");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";

  if (!email || !password) {
    console.error("Fehler: ADMIN_EMAIL und ADMIN_PASSWORD müssen gesetzt sein.");
    process.exit(1);
  }

  if (!validatePassword(password)) {
    console.error(
      "Fehler: Passwort muss mindestens 10 Zeichen, einen Grossbuchstaben, eine Zahl und ein Sonderzeichen enthalten."
    );
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(password, 12);

  try {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id, email, created_at`,
      [email, password_hash]
    );

    const user = result.rows[0];
    console.log(`Admin gesetzt: ${user.email} (ID: ${user.id})`);
  } catch (err) {
    console.error("Seed-Fehler:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
