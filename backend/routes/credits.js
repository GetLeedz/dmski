const express = require("express");
const { Pool } = require("pg");
const { requireAuth } = require("../middleware/auth");
const { writeLog } = require("./audit");

const router = express.Router();

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  const trimmed = String(rawUrl).trim().replace(/^['\"]|['\"]$/g, "").replace(/\s+/g, "");
  try { new URL(trimmed); return trimmed; } catch {
    const match = trimmed.match(/^(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@([^/]+)\/(.+)$/i);
    if (!match) return trimmed;
    const [, protocol, user, password, host, dbPath] = match;
    return `${protocol}${user}:${encodeURIComponent(password)}@${host}/${dbPath}`;
  }
}

const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL) });

// ── Ensure tables exist on first request ──
let schemaDone = false;
async function ensureSchema() {
  if (schemaDone) return;
  schemaDone = true;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS credit_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      price_per_credit NUMERIC(10,2) NOT NULL DEFAULT 5.00,
      currency TEXT NOT NULL DEFAULT 'CHF',
      free_signup_credits INTEGER NOT NULL DEFAULT 10,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`INSERT INTO credit_settings (id, price_per_credit, currency, free_signup_credits) VALUES (1, 5.00, 'CHF', 10) ON CONFLICT (id) DO NOTHING`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_credits (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0,
      total_purchased INTEGER NOT NULL DEFAULT 0,
      total_spent INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS credit_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('purchase','signup_bonus','deduct','admin_grant','refund')),
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description TEXT,
      stripe_session_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions (user_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_tx_stripe ON credit_transactions (stripe_session_id) WHERE stripe_session_id IS NOT NULL`);
    await pool.query(`CREATE TABLE IF NOT EXISTS credit_packages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      credits INTEGER NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CHF',
      popular BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Add unique constraint if missing, then seed packages
    await pool.query(`ALTER TABLE credit_packages ADD CONSTRAINT IF NOT EXISTS credit_packages_name_key UNIQUE (name)`).catch(() => {});
    // Clean up duplicates first
    await pool.query(`DELETE FROM credit_packages a USING credit_packages b WHERE a.id > b.id AND a.name = b.name`).catch(() => {});
    await pool.query(`INSERT INTO credit_packages (name, credits, price, popular, sort_order) VALUES ('Starter', 50, 250.00, false, 1), ('Standard', 150, 675.00, true, 2), ('Professional', 500, 2000.00, false, 3) ON CONFLICT (name) DO NOTHING`);
    console.log("[credits] Schema ensured.");
  } catch (err) {
    if (!err.message?.includes("already exists")) {
      schemaDone = false;
      console.warn("[credits] Schema warn:", err.message);
    }
  }
}

// ── Helper: get or create user credit row ──
async function getOrCreateBalance(userId) {
  await pool.query(
    `INSERT INTO user_credits (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  const r = await pool.query(`SELECT balance, total_purchased, total_spent FROM user_credits WHERE user_id = $1`, [userId]);
  return r.rows[0] || { balance: 0, total_purchased: 0, total_spent: 0 };
}

// ── Helper: get settings ──
async function getSettings() {
  const r = await pool.query(`SELECT * FROM credit_settings WHERE id = 1`);
  return r.rows[0] || { price_per_credit: 5, currency: "CHF", free_signup_credits: 10 };
}

// ══════════════════════════════════════════════
// GET /credits/balance – User's credit balance
// ══════════════════════════════════════════════
router.get("/balance", requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const credits = await getOrCreateBalance(req.user.sub);
    const settings = await getSettings();
    res.json({ ...credits, price_per_credit: Number(settings.price_per_credit), currency: settings.currency });
  } catch (err) {
    console.error("[credits] balance error:", err.message);
    res.status(500).json({ error: "Konnte Credits nicht laden." });
  }
});

// ══════════════════════════════════════════════
// GET /credits/packages – Available packages
// ══════════════════════════════════════════════
router.get("/packages", async (req, res) => {
  try {
    await ensureSchema();
    const r = await pool.query(`SELECT id, name, credits, price, currency, popular FROM credit_packages WHERE active = true ORDER BY sort_order`);
    const settings = await getSettings();
    res.json({ packages: r.rows, price_per_credit: Number(settings.price_per_credit), currency: settings.currency });
  } catch (err) {
    console.error("[credits] packages error:", err.message);
    res.status(500).json({ error: "Pakete konnten nicht geladen werden." });
  }
});

// ══════════════════════════════════════════════
// POST /credits/checkout – Create Stripe session
// ══════════════════════════════════════════════
router.post("/checkout", requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(503).json({ error: "Zahlungssystem nicht konfiguriert." });

    const stripe = require("stripe")(stripeKey);
    const { packageId } = req.body;
    if (!packageId) return res.status(400).json({ error: "Paket-ID fehlt." });

    const pkgRes = await pool.query(`SELECT * FROM credit_packages WHERE id = $1 AND active = true`, [packageId]);
    const pkg = pkgRes.rows[0];
    if (!pkg) return res.status(404).json({ error: "Paket nicht gefunden." });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: req.user.email,
      line_items: [{
        price_data: {
          currency: pkg.currency.toLowerCase(),
          product_data: {
            name: `DMSKI Credits – ${pkg.name}`,
            description: `${pkg.credits} Credits für KI-Fallanalyse`,
          },
          unit_amount: Math.round(Number(pkg.price) * 100),
        },
        quantity: 1,
      }],
      metadata: {
        user_id: req.user.sub,
        package_id: String(pkg.id),
        credits: String(pkg.credits),
      },
      success_url: `https://dmski.ch/credits.html?success=1`,
      cancel_url: `https://dmski.ch/credits.html?cancelled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[credits] checkout error:", err.message);
    res.status(500).json({ error: "Checkout konnte nicht erstellt werden." });
  }
});

// ══════════════════════════════════════════════
// POST /credits/webhook – Stripe webhook
// ══════════════════════════════════════════════
router.post("/webhook", async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeKey) return res.status(503).send("Not configured");

  const stripe = require("stripe")(stripeKey);

  let event;
  try {
    if (webhookSecret) {
      const sig = req.headers["stripe-signature"];
      // req.body is a Buffer from express.raw() in index.js
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // No webhook secret: parse body directly
      const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
      event = typeof body === "string" ? JSON.parse(body) : body;
    }
  } catch (err) {
    console.error("[credits] webhook sig error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  console.log("[credits] webhook event:", event.type);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.user_id;
    const credits = parseInt(session.metadata?.credits || "0", 10);
    const sessionId = session.id;

    if (!userId || !credits) {
      console.warn("[credits] webhook missing metadata", session.metadata);
      return res.json({ received: true });
    }

    try {
      await ensureSchema();
      // Idempotency: check if already processed
      const existing = await pool.query(
        `SELECT id FROM credit_transactions WHERE stripe_session_id = $1`, [sessionId]
      );
      if (existing.rows.length > 0) {
        console.log("[credits] webhook already processed:", sessionId);
        return res.json({ received: true });
      }

      // Credit the user
      await getOrCreateBalance(userId);
      const upd = await pool.query(
        `UPDATE user_credits SET balance = balance + $1, total_purchased = total_purchased + $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance`,
        [credits, userId]
      );
      const newBalance = upd.rows[0]?.balance || credits;

      await pool.query(
        `INSERT INTO credit_transactions (user_id, type, amount, balance_after, description, stripe_session_id) VALUES ($1, 'purchase', $2, $3, $4, $5)`,
        [userId, credits, newBalance, `${credits} Credits gekauft`, sessionId]
      );

      console.log(`[credits] +${credits} credits for user ${userId} (session: ${sessionId})`);
    } catch (err) {
      console.error("[credits] webhook DB error:", err.message);
      return res.status(500).send("DB Error");
    }
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════════
// POST /credits/deduct – Deduct credits (internal)
// ══════════════════════════════════════════════
async function deductCredits(userId, amount, description) {
  await ensureSchema();
  await getOrCreateBalance(userId);
  const check = await pool.query(`SELECT balance FROM user_credits WHERE user_id = $1`, [userId]);
  const balance = check.rows[0]?.balance || 0;
  if (balance < amount) {
    return { success: false, balance, needed: amount, error: "Nicht genügend Credits." };
  }
  const upd = await pool.query(
    `UPDATE user_credits SET balance = balance - $1, total_spent = total_spent + $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance`,
    [amount, userId]
  );
  const newBalance = upd.rows[0]?.balance || 0;
  await pool.query(
    `INSERT INTO credit_transactions (user_id, type, amount, balance_after, description) VALUES ($1, 'deduct', $2, $3, $4)`,
    [userId, -amount, newBalance, description]
  );
  return { success: true, balance: newBalance, spent: amount };
}

// ══════════════════════════════════════════════
// POST /credits/grant – Admin grants free credits
// ══════════════════════════════════════════════
router.post("/grant", requireAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Nur für Admins." });
  try {
    await ensureSchema();
    const { userId, amount, description } = req.body;
    if (!userId || !amount || amount < 1) return res.status(400).json({ error: "userId und amount erforderlich." });

    await getOrCreateBalance(userId);
    const upd = await pool.query(
      `UPDATE user_credits SET balance = balance + $1, total_purchased = total_purchased + $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance`,
      [amount, userId]
    );
    const newBalance = upd.rows[0]?.balance || amount;
    await pool.query(
      `INSERT INTO credit_transactions (user_id, type, amount, balance_after, description) VALUES ($1, 'admin_grant', $2, $3, $4)`,
      [userId, amount, newBalance, description || `${amount} Credits vom Admin gutgeschrieben`]
    );
    res.json({ ok: true, balance: newBalance });
  } catch (err) {
    console.error("[credits] grant error:", err.message);
    res.status(500).json({ error: "Fehler beim Gutschreiben." });
  }
});

// ══════════════════════════════════════════════
// GET /credits/transactions – User's transaction history
// ══════════════════════════════════════════════
router.get("/transactions", requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const r = await pool.query(
      `SELECT id, type, amount, balance_after, description, created_at FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.sub]
    );
    res.json({ transactions: r.rows });
  } catch (err) {
    console.error("[credits] transactions error:", err.message);
    res.status(500).json({ error: "Transaktionen konnten nicht geladen werden." });
  }
});

// ══════════════════════════════════════════════
// ADMIN: GET /credits/admin/overview
// ══════════════════════════════════════════════
router.get("/admin/overview", requireAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Nur für Admins." });
  try {
    await ensureSchema();
    const r = await pool.query(`
      SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.last_login_at,
             COALESCE(uc.balance, 0) AS balance,
             COALESCE(uc.total_purchased, 0) AS total_purchased,
             COALESCE(uc.total_spent, 0) AS total_spent,
             (SELECT COUNT(*) FROM case_documents cd JOIN cases c ON cd.case_id = c.id WHERE EXISTS (SELECT 1 FROM users u2 WHERE u2.id = u.id AND u2.case_id = c.id)) AS file_count
      FROM users u
      LEFT JOIN user_credits uc ON uc.user_id = u.id
      ORDER BY COALESCE(uc.total_purchased, 0) DESC
    `);
    const settings = await getSettings();
    res.json({ users: r.rows, settings });
  } catch (err) {
    console.error("[credits] admin overview error:", err.message);
    res.status(500).json({ error: "Übersicht konnte nicht geladen werden." });
  }
});

// ══════════════════════════════════════════════
// ADMIN: PATCH /credits/admin/settings
// ══════════════════════════════════════════════
router.patch("/admin/settings", requireAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Nur für Admins." });
  try {
    await ensureSchema();
    const { price_per_credit, free_signup_credits } = req.body;
    const updates = [];
    const values = [];
    let i = 1;
    if (price_per_credit !== undefined) { updates.push(`price_per_credit = $${i++}`); values.push(price_per_credit); }
    if (free_signup_credits !== undefined) { updates.push(`free_signup_credits = $${i++}`); values.push(free_signup_credits); }
    if (updates.length === 0) return res.status(400).json({ error: "Keine Änderungen." });
    updates.push(`updated_at = NOW()`);
    await pool.query(`UPDATE credit_settings SET ${updates.join(", ")} WHERE id = 1`, values);
    const settings = await getSettings();
    res.json({ ok: true, settings });
  } catch (err) {
    console.error("[credits] settings error:", err.message);
    res.status(500).json({ error: "Einstellungen konnten nicht gespeichert werden." });
  }
});

// ══════════════════════════════════════════════
// ADMIN: PATCH /credits/admin/packages/:id
// ══════════════════════════════════════════════
router.patch("/admin/packages/:id", requireAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Nur für Admins." });
  try {
    await ensureSchema();
    const { name, credits, price, popular, active, sort_order } = req.body;
    const updates = [];
    const values = [];
    let i = 1;
    if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name); }
    if (credits !== undefined) { updates.push(`credits = $${i++}`); values.push(credits); }
    if (price !== undefined) { updates.push(`price = $${i++}`); values.push(price); }
    if (popular !== undefined) { updates.push(`popular = $${i++}`); values.push(popular); }
    if (active !== undefined) { updates.push(`active = $${i++}`); values.push(active); }
    if (sort_order !== undefined) { updates.push(`sort_order = $${i++}`); values.push(sort_order); }
    if (updates.length === 0) return res.status(400).json({ error: "Keine Änderungen." });
    values.push(req.params.id);
    await pool.query(`UPDATE credit_packages SET ${updates.join(", ")} WHERE id = $${i}`, values);
    res.json({ ok: true });
  } catch (err) {
    console.error("[credits] package update error:", err.message);
    res.status(500).json({ error: "Paket konnte nicht aktualisiert werden." });
  }
});

module.exports = router;
module.exports.deductCredits = deductCredits;
module.exports.getOrCreateBalance = getOrCreateBalance;
module.exports.ensureSchema = ensureSchema;
