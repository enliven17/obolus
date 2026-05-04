// @ts-check
// Obolus VCC Service — issues virtual cards for orders.
//
// Two modes (selected by env):
//   STRIPE_SECRET_KEY set → Stripe Issuing test mode (unique card per order)
//   STRIPE_SECRET_KEY unset → hardcoded Stripe test cards (no account needed)

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.VCC_PORT || 5000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

const app = express();
app.use(express.json());

// ── Stripe Issuing ────────────────────────────────────────────────────────────

let stripe = null;
if (STRIPE_SECRET_KEY) {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
}

// Shared cardholder created once at startup and reused for every order.
// In test mode this is a fictional entity; Stripe doesn't KYC test cardholders.
let sharedCardholderId = null;

async function ensureCardholder() {
  if (sharedCardholderId) return sharedCardholderId;
  const ch = await stripe.issuing.cardholders.create({
    type: 'individual',
    name: 'Obolus Agent',
    email: 'agent@obolus.dev',
    billing: {
      address: {
        line1: '123 Main St',
        city: 'San Francisco',
        state: 'CA',
        postal_code: '94111',
        country: 'US',
      },
    },
  });
  sharedCardholderId = ch.id;
  console.log(`[vcc] stripe cardholder ready: ${ch.id}`);
  return ch.id;
}

async function issueStripeCard(amountUsdc) {
  const cardholderId = await ensureCardholder();
  // Convert USDC amount to cents for Stripe (1 USDC = $1 = 100 cents)
  const amountCents = Math.max(1, Math.round(parseFloat(amountUsdc) * 100));

  const card = await stripe.issuing.cards.create({
    cardholder: cardholderId,
    type: 'virtual',
    currency: 'usd',
    spending_controls: {
      spending_limits: [{ amount: amountCents, interval: 'per_authorization' }],
    },
  });

  // Retrieve with PAN + CVV expanded — only works in test mode without frontend
  const revealed = await stripe.issuing.cards.retrieve(card.id, {
    expand: ['number', 'cvc'],
  });

  return {
    number: /** @type {string} */ (/** @type {any} */ (revealed).number),
    cvv: /** @type {string} */ (/** @type {any} */ (revealed).cvc),
    expiry: `${String(revealed.exp_month).padStart(2, '0')}/${String(revealed.exp_year).slice(-2)}`,
    brand: revealed.brand,
    stripeCardId: card.id,
  };
}

// ── Fallback test card pool ───────────────────────────────────────────────────
// Used when STRIPE_SECRET_KEY is not configured.
const FALLBACK_CARDS = [
  { number: '4242424242424242', cvv: '314', expiry: '12/27', brand: 'Visa' },
  { number: '4000056655665556', cvv: '123', expiry: '08/27', brand: 'Visa (debit)' },
  { number: '5555555555554444', cvv: '456', expiry: '10/27', brand: 'Mastercard' },
];

function pickFallbackCard() {
  return FALLBACK_CARDS[Math.floor(Math.random() * FALLBACK_CARDS.length)];
}

async function issueCard(amountUsdc) {
  if (stripe) {
    return issueStripeCard(amountUsdc);
  }
  return pickFallbackCard();
}

// ── In-memory job store ───────────────────────────────────────────────────────
const jobs = new Map();

// ── HMAC callback to backend ──────────────────────────────────────────────────

async function sendCallback(callbackUrl, callbackSecret, callbackNonce, orderId, card) {
  const body = JSON.stringify({
    order_id: orderId,
    status: 'fulfilled',
    card: {
      number: card.number,
      cvv: card.cvv,
      expiry: card.expiry,
      brand: card.brand,
    },
  });

  const timestamp = String(Date.now());
  // v3 HMAC: sha256("<timestamp>.<orderId>.<nonce>.<body>") when nonce present
  // v2 HMAC: sha256("<timestamp>.<orderId>.<body>") fallback
  const payload = callbackNonce
    ? `${timestamp}.${orderId}.${callbackNonce}.${body}`
    : `${timestamp}.${orderId}.${body}`;
  const sig = crypto.createHmac('sha256', callbackSecret).update(payload).digest('hex');

  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VCC-Signature': `sha256=${sig}`,
        'X-VCC-Timestamp': timestamp,
        'X-VCC-Order-Id': orderId,
        'X-VCC-Nonce': callbackNonce || '',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[vcc] callback sent for ${orderId.slice(0, 8)}… → HTTP ${res.status}`);
  } catch (err) {
    console.error(`[vcc] callback failed for ${orderId.slice(0, 8)}…: ${/** @type {any} */ (err).message}`);
    // Retry once after 5s
    setTimeout(() => sendCallback(callbackUrl, callbackSecret, callbackNonce, orderId, card), 5000);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/register — Obolus backend self-registers on first boot
app.post('/api/register', (_req, res) => {
  const token = `vcc_${crypto.randomBytes(16).toString('hex')}`;
  console.log('[vcc] registered new tenant');
  res.json({ token });
});

// POST /api/jobs/invoice — Create a card fulfillment job
app.post('/api/jobs/invoice', (req, res) => {
  const { order_id, amount_usdc, callback_url, callback_secret, callback_nonce } = req.body;

  if (!order_id || !amount_usdc || !callback_url || !callback_secret) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    orderId: order_id,
    amountUsdc: amount_usdc,
    callbackUrl: callback_url,
    callbackSecret: callback_secret,
    callbackNonce: callback_nonce || null,
    status: 'invoice_issued',
    card: null,
    createdAt: new Date().toISOString(),
  });

  console.log(`[vcc] invoice created: job=${jobId.slice(0, 8)}… order=${order_id.slice(0, 8)}… amount=$${amount_usdc}`);

  res.json({ job_id: jobId, payment_url: `vcc:pending?job=${jobId}` });
});

// POST /api/jobs/:id/paid — Backend notifies payment confirmed; issue the card
app.post('/api/jobs/:id/paid', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found' });

  if (job.status !== 'invoice_issued') {
    return res.status(409).json({ error: 'already_processing', status: job.status });
  }

  job.status = 'fulfilling';
  console.log(`[vcc] fulfillment started: job=${job.jobId.slice(0, 8)}… order=${job.orderId.slice(0, 8)}…`);

  res.json({ ok: true });

  // Issue card async — Stripe call takes ~500ms, fallback is instant
  issueCard(job.amountUsdc)
    .then(async (card) => {
      job.card = card;
      job.status = 'fulfilled';
      console.log(
        `[vcc] card issued: ${card.brand} ****${card.number.slice(-4)} for order ${job.orderId.slice(0, 8)}…` +
          (card.stripeCardId ? ` (stripe: ${card.stripeCardId})` : ' (fallback)'),
      );
      await sendCallback(job.callbackUrl, job.callbackSecret, job.callbackNonce, job.orderId, card);
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
      console.error(`[vcc] card issuance failed for ${job.jobId.slice(0, 8)}…: ${err.message}`);

      // If Stripe fails, fall back to test card so the order isn't stuck
      if (stripe) {
        console.warn('[vcc] stripe failed — falling back to test card');
        const card = pickFallbackCard();
        job.card = card;
        job.status = 'fulfilled';
        sendCallback(job.callbackUrl, job.callbackSecret, job.callbackNonce, job.orderId, card).catch(
          () => {},
        );
      }
    });
});

// GET /api/jobs/:id — Poll job status (fallback when callback is lost)
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job_not_found' });

  /** @type {Record<string, any>} */
  const response = {
    job_id: job.jobId,
    order_id: job.orderId,
    status: job.status,
    amount_usdc: job.amountUsdc,
    created_at: job.createdAt,
  };

  if (job.status === 'fulfilled' && job.card) {
    response.card = {
      number: job.card.number,
      cvv: job.card.cvv,
      expiry: job.card.expiry,
      brand: job.card.brand,
    };
  }

  if (job.status === 'failed') {
    response.error = job.error;
  }

  res.json(response);
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    jobs: jobs.size,
    mode: stripe ? 'stripe_issuing' : 'test_cards',
  });
});

app.listen(PORT, () => {
  console.log(`[vcc] service running on port ${PORT}`);
  if (stripe) {
    console.log('[vcc] mode: stripe issuing (unique card per order)');
  } else {
    console.log('[vcc] mode: test cards (set STRIPE_SECRET_KEY to enable Stripe Issuing)');
  }
  console.log(`[vcc] backend: ${BACKEND_URL}`);
});
