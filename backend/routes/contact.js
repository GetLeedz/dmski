const express = require("express");
const { Resend } = require("resend");
const { Pool } = require("pg");

const router = express.Router();

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  return String(rawUrl).trim().replace(/^["']+|["']+$/g, "");
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL) });

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "0x4AAAAAACxqY5ny-6FUdG1wJsiPPTAUhjQ";
const RECIPIENT = process.env.CONTACT_RECIPIENT || "ayhan.ergen@getleedz.com";

function esc(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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

  const rolleLabel = ROLLE_LABELS[rolle] || rolle;

  // 1. Save to database (always works)
  try {
    await ensureContactTable();
    await pool.query(
      `INSERT INTO contact_requests (vorname, nachname, email, telefon, rolle, nachricht)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [vorname.trim(), nachname.trim(), email.trim(), (telefon || "").trim(), rolle, nachricht.trim()]
    );
    console.log(`[contact] Anfrage gespeichert: ${email} (${rolleLabel})`);
  } catch (err) {
    console.error("[contact] DB save error:", err.message);
    return res.status(500).json({ error: "Anfrage konnte nicht gespeichert werden." });
  }

  // 2. Send email via Resend (HTTPS API, no SMTP ports needed)
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const now = new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" });
      const htmlBody = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;border-radius:12px;overflow:hidden">
          <div style="background:#1A2B3C;padding:1.5rem 2rem">
            <h2 style="margin:0;color:#F8F9FA;font-size:1.2rem">Neue Zugangsanfrage</h2>
            <p style="margin:0.3rem 0 0;color:rgba(255,255,255,0.5);font-size:0.85rem">${esc(now)}</p>
          </div>
          <div style="padding:1.5rem 2rem">
            <table style="width:100%;border-collapse:collapse;font-size:0.92rem">
              <tr><td style="padding:0.5rem 0;color:#6b7b8a;width:120px">Name</td><td style="padding:0.5rem 0;color:#1A2B3C;font-weight:600">${esc(vorname)} ${esc(nachname)}</td></tr>
              <tr><td style="padding:0.5rem 0;color:#6b7b8a">E-Mail</td><td style="padding:0.5rem 0"><a href="mailto:${esc(email)}" style="color:#C5A059">${esc(email)}</a></td></tr>
              ${telefon ? `<tr><td style="padding:0.5rem 0;color:#6b7b8a">Telefon</td><td style="padding:0.5rem 0;color:#1A2B3C">${esc(telefon)}</td></tr>` : ""}
              <tr><td style="padding:0.5rem 0;color:#6b7b8a">Rolle</td><td style="padding:0.5rem 0;color:#1A2B3C;font-weight:600">${esc(rolleLabel)}</td></tr>
            </table>
            <div style="margin-top:1rem;padding:1rem;background:#fff;border-radius:8px;border:1px solid #e8edf2">
              <p style="margin:0 0 0.3rem;font-size:0.75rem;color:#6b7b8a;text-transform:uppercase;letter-spacing:0.05em;font-weight:700">Nachricht</p>
              <p style="margin:0;color:#1A2B3C;line-height:1.6;white-space:pre-wrap">${esc(nachricht)}</p>
            </div>
          </div>
        </div>`;

      const resend = new Resend(resendKey);
      await resend.emails.send({
        from: "DMSKI Forensik-System <onboarding@resend.dev>",
        to: [RECIPIENT],
        replyTo: email,
        subject: `Zugangsanfrage: ${vorname} ${nachname} (${rolleLabel})`,
        html: htmlBody,
      });
      console.log(`[contact] E-Mail gesendet via Resend an ${RECIPIENT}`);
    } catch (mailErr) {
      console.warn(`[contact] Resend fehlgeschlagen: ${mailErr.message}`);
    }
  } else {
    console.log("[contact] RESEND_API_KEY nicht gesetzt — E-Mail übersprungen (DB-Eintrag existiert)");
  }

  return res.json({ ok: true, message: "Anfrage erfolgreich gesendet." });
});

// GET all requests (for admin)
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
