const express = require("express");
const nodemailer = require("nodemailer");

const router = express.Router();

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "0x4AAAAAACxqY5ny-6FUdG1wJsiPPTAUhjQ";
const RECIPIENT = process.env.CONTACT_RECIPIENT || "ayhan.ergen@getleedz.com";

function createMailTransport() {
  const smtpUser = process.env.SMTP_USER || "info@dmski.ch";
  const smtpPass = process.env.SMTP_PASS || "";
  const config = {
    host: "asmtp.mail.hostpoint.ch",
    port: 465,
    secure: true,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  };
  // Hostpoint allows auth with just username (password can be empty)
  if (smtpPass) {
    config.auth = { user: smtpUser, pass: smtpPass };
  } else {
    config.auth = { user: smtpUser, pass: process.env.SMTP_ACCOUNT_PASS || "SEtdoCtv*OGS1p%!" };
  }
  return nodemailer.createTransport(config);
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ROLLE_LABELS = {
  betroffene_person: "Betroffene Person",
  anwalt: "Anwältin / Anwalt",
  gutachter: "Gutachter / Forensiker",
  berater: "Berater / Sozialarbeiter",
  andere: "Andere",
};

router.post("/", async (req, res) => {
  const { vorname, nachname, email, telefon, rolle, nachricht, turnstileToken } = req.body || {};

  // Validate required fields
  if (!vorname || !nachname || !email || !rolle || !nachricht) {
    return res.status(400).json({ error: "Bitte füllen Sie alle Pflichtfelder aus." });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Bitte geben Sie eine gültige E-Mail-Adresse ein." });
  }

  // Verify Turnstile token
  if (!turnstileToken) {
    return res.status(400).json({ error: "Bitte bestätigen Sie, dass Sie kein Roboter sind." });
  }

  try {
    const turnstileRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET,
        response: turnstileToken,
      }),
    });
    const turnstileData = await turnstileRes.json();
    if (!turnstileData.success) {
      return res.status(403).json({ error: "Sicherheitsprüfung fehlgeschlagen. Bitte versuchen Sie es erneut." });
    }
  } catch (err) {
    console.warn("Turnstile verification failed:", err.message);
    return res.status(500).json({ error: "Sicherheitsprüfung konnte nicht durchgeführt werden." });
  }

  // Send email
  const rolleLabel = ROLLE_LABELS[rolle] || rolle;
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
      <div style="padding:1rem 2rem;background:#f0f2f5;font-size:0.78rem;color:#8a96a3">
        Gesendet über dmski.ch/zugang.html
      </div>
    </div>
  `;

  try {
    const transporter = createMailTransport();
    await transporter.sendMail({
      from: `"DMSKI Plattform" <${process.env.SMTP_USER || "info@dmski.ch"}>`,
      to: RECIPIENT,
      replyTo: email,
      subject: `DMSKI Zugangsanfrage: ${vorname} ${nachname} (${rolleLabel})`,
      html: htmlBody,
    });

    console.log(`[contact] Zugangsanfrage von ${email} (${rolleLabel})`);
    return res.json({ ok: true, message: "Anfrage erfolgreich gesendet." });
  } catch (err) {
    console.error("[contact] Mail send error:", err.message);
    return res.status(500).json({ error: "E-Mail konnte nicht gesendet werden. Bitte versuchen Sie es später erneut." });
  }
});

module.exports = router;
