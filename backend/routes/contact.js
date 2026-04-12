const express = require("express");
const { Resend } = require("resend");
const { Pool } = require("pg");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  return String(rawUrl).trim().replace(/^["']+|["']+$/g, "");
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL) });

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "0x4AAAAAACxqY5ny-6FUdG1wJsiPPTAUhjQ";
const RECIPIENT = process.env.CONTACT_RECIPIENT || "info@dmski.ch";

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
      const htmlBody = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0e17;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e17;padding:40px 20px;">
<tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#1A2B3C;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.4);">

  <tr><td style="height:2px;background:linear-gradient(90deg,transparent,#C5A059,#8b5cf6,#C5A059,transparent);font-size:0;line-height:0;">&nbsp;</td></tr>

  <tr>
    <td style="background:#1A2B3C;padding:32px 40px 24px;text-align:center;">
      <img src="https://www.dmski.ch/assets/logo-dmski_gold.png" alt="DMSKI" width="140" style="display:inline-block;max-width:140px;height:auto;border:0;outline:none;text-decoration:none;" />
      <p style="color:rgba(255,255,255,.5);font-size:12px;margin:10px 0 0;">Neue Zugangsanfrage</p>
    </td>
  </tr>

  <tr>
    <td style="background:#ffffff;padding:32px 40px;">
      <p style="margin:0 0 20px;font-size:15px;color:#1A2B3C;line-height:1.6;">
        Eine neue Zugangsanfrage ist über <strong>dmski.ch</strong> eingegangen:
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border:1px solid #e2e8ef;border-radius:10px;overflow:hidden;margin-bottom:20px;">
        <tr><td style="padding:14px 20px;border-bottom:1px solid #e2e8ef;">
          <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:rgba(26,43,60,.45);text-transform:uppercase;letter-spacing:.08em;">Name</p>
          <span style="color:#1A2B3C;font-size:15px;font-weight:700;">${esc(vorname)} ${esc(nachname)}</span>
        </td></tr>
        <tr><td style="padding:14px 20px;border-bottom:1px solid #e2e8ef;">
          <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:rgba(26,43,60,.45);text-transform:uppercase;letter-spacing:.08em;">E-Mail</p>
          <a href="mailto:${esc(email)}" style="color:#C5A059;font-size:14px;font-weight:600;text-decoration:none;">${esc(email)}</a>
        </td></tr>
        ${telefon ? `<tr><td style="padding:14px 20px;border-bottom:1px solid #e2e8ef;">
          <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:rgba(26,43,60,.45);text-transform:uppercase;letter-spacing:.08em;">Telefon</p>
          <span style="color:#1A2B3C;font-size:14px;font-weight:600;">${esc(telefon)}</span>
        </td></tr>` : ""}
        <tr><td style="padding:14px 20px;">
          <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:rgba(26,43,60,.45);text-transform:uppercase;letter-spacing:.08em;">Rolle</p>
          <span style="color:#1A2B3C;font-size:14px;font-weight:700;">${esc(rolleLabel)}</span>
        </td></tr>
      </table>

      <div style="padding:16px 20px;background:#f8f9fa;border-radius:10px;border-left:3px solid #C5A059;margin-bottom:20px;">
        <p style="margin:0 0 6px;font-size:10px;font-weight:700;color:rgba(26,43,60,.45);text-transform:uppercase;letter-spacing:.08em;">Nachricht</p>
        <p style="margin:0;color:#1A2B3C;font-size:14px;line-height:1.7;white-space:pre-wrap;">${esc(nachricht)}</p>
      </div>

      <p style="margin:0;font-size:12px;color:#8a96a3;">
        Eingegangen am ${esc(now)} &middot; <a href="mailto:${esc(email)}" style="color:#C5A059;text-decoration:none;">Direkt antworten</a>
      </p>
    </td>
  </tr>

  <tr>
    <td style="background:#0f1520;padding:20px 40px;text-align:center;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:rgba(255,255,255,.4);">DMSKI &middot; GetLeedz GmbH</p>
      <p style="margin:0;font-size:10px;color:rgba(255,255,255,.25);">Walter Fürst-Strasse 1 &middot; CH-4102 Binningen &middot; <a href="https://dmski.ch" style="color:rgba(197,160,89,.5);text-decoration:none;">dmski.ch</a></p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;

      const resend = new Resend(resendKey);
      await resend.emails.send({
        from: "DMSKI <info@dmski.ch>",
        to: ["info@dmski.ch"],
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

// GET all requests (admin only)
router.get("/", requireAuth, requireAdmin, async (req, res) => {
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
