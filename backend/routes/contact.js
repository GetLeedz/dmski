const express = require("express");
const { Pool } = require("pg");

const router = express.Router();

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  return String(rawUrl).trim().replace(/^["']+|["']+$/g, "");
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL) });

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "0x4AAAAAACxqY5ny-6FUdG1wJsiPPTAUhjQ";

const ROLLE_LABELS = {
  betroffene_person: "Betroffene Person",
  anwalt: "Anwältin / Anwalt",
  gutachter: "Gutachter / Forensiker",
  berater: "Berater / Sozialarbeiter",
  andere: "Andere",
};

// Ensure contact_requests table exists
let tableInitPromise = null;
async function ensureContactTable() {
  if (!tableInitPromise) {
    tableInitPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS contact_requests (
        id SERIAL PRIMARY KEY,
        vorname TEXT NOT NULL,
        nachname TEXT NOT NULL,
        email TEXT NOT NULL,
        telefon TEXT,
        rolle TEXT NOT NULL,
        nachricht TEXT NOT NULL,
        status TEXT DEFAULT 'neu',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).catch((err) => {
      console.warn("Could not create contact_requests table:", err.message);
      tableInitPromise = null;
    });
  }
  await tableInitPromise;
}

router.post("/", async (req, res) => {
  const { vorname, nachname, email, telefon, rolle, nachricht, turnstileToken } = req.body || {};

  if (!vorname || !nachname || !email || !rolle || !nachricht) {
    return res.status(400).json({ error: "Bitte füllen Sie alle Pflichtfelder aus." });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Bitte geben Sie eine gültige E-Mail-Adresse ein." });
  }

  if (!turnstileToken) {
    return res.status(400).json({ error: "Bitte bestätigen Sie, dass Sie kein Roboter sind." });
  }

  // Verify Turnstile
  try {
    const turnstileRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: turnstileToken }),
    });
    const turnstileData = await turnstileRes.json();
    if (!turnstileData.success) {
      return res.status(403).json({ error: "Sicherheitsprüfung fehlgeschlagen. Bitte versuchen Sie es erneut." });
    }
  } catch (err) {
    console.warn("Turnstile verification failed:", err.message);
    return res.status(500).json({ error: "Sicherheitsprüfung konnte nicht durchgeführt werden." });
  }

  // Save to database
  try {
    await ensureContactTable();
    await pool.query(
      `INSERT INTO contact_requests (vorname, nachname, email, telefon, rolle, nachricht)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [vorname.trim(), nachname.trim(), email.trim(), (telefon || "").trim(), rolle, nachricht.trim()]
    );

    const rolleLabel = ROLLE_LABELS[rolle] || rolle;
    console.log(`[contact] Neue Zugangsanfrage gespeichert: ${email} (${rolleLabel})`);
    return res.json({ ok: true, message: "Anfrage erfolgreich gesendet." });
  } catch (err) {
    console.error("[contact] DB save error:", err.message);
    return res.status(500).json({ error: "Anfrage konnte nicht gespeichert werden. Bitte versuchen Sie es später erneut." });
  }
});

// GET all requests (admin only — protected by requireAuth in a future iteration)
router.get("/", async (req, res) => {
  try {
    await ensureContactTable();
    const result = await pool.query("SELECT * FROM contact_requests ORDER BY created_at DESC");
    return res.json(result.rows);
  } catch (err) {
    console.error("[contact] GET error:", err.message);
    return res.status(500).json({ error: "Anfragen konnten nicht geladen werden." });
  }
});

module.exports = router;
