// Solana devnet E2E test — simüle ödeme kullanır (gerçek USDC gerekmez)
//
// Akış:
//   1. Geçici test API key oluştur
//   2. POST /v1/orders  → order oluştur
//   3. POST /dev/simulate-payment/:id  → Solana ödeme simüle et
//   4. GET /v1/orders/:id poll → "ready" olana kadar bekle
//   5. Kart bilgilerini göster (Stripe Issuing)
//   6. Test key'i temizle
//
// Kullanım: node test-solana-e2e.js [amount_usdc]
//           amount_usdc varsayılan: 1.00

require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./src/db');

const AMOUNT = process.argv[2] || '1.00';
const BASE = `http://localhost:${process.env.PORT || 4000}`;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

function log(step, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${step}] ${msg}`);
}

async function createTestKey() {
  const raw = `obolus_${crypto.randomBytes(24).toString('hex')}`;
  const hash = await bcrypt.hash(raw, 10);
  const id = crypto.randomUUID();
  const prefix = raw.slice(9, 21);
  db.prepare(
    `INSERT INTO api_keys (id, key_hash, key_prefix, label, mode, enabled)
     VALUES (?, ?, ?, 'e2e-test', 'live', 1)`,
  ).run(id, hash, prefix);
  return { id, raw };
}

async function deleteTestKey(id) {
  db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id);
}

async function main() {
  console.log(`\n${'═'.repeat(55)}`);
  console.log(` Obolus Solana E2E Test — $${AMOUNT} USDC`);
  console.log(`${'═'.repeat(55)}\n`);

  const t0 = Date.now();

  // ── 1. Test API key ──────────────────────────────────────────────────────────
  const key = await createTestKey();
  log('1', `Test API key oluşturuldu: ${key.id.slice(0, 8)}…`);

  let orderId;
  try {
    // ── 2. Order oluştur ───────────────────────────────────────────────────────
    const orderRes = await fetch(`${BASE}/v1/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key.raw },
      body: JSON.stringify({ amount_usdc: AMOUNT }),
    });

    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`POST /v1/orders → ${orderRes.status}: ${body}`);
    }

    const order = await orderRes.json();
    orderId = order.order_id;

    log('2', `Order oluşturuldu: ${orderId}`);
    log('2', `Tutar: $${order.payment?.usdc?.amount || AMOUNT} USDC`);
    log('2', `Program: ${order.payment?.usdc?.program_id || '—'}`);

    // ── 3. Ödeme simüle et ─────────────────────────────────────────────────────
    const tPay = Date.now();
    log('3', 'Solana ödeme simüle ediliyor…');

    const simRes = await fetch(`${BASE}/dev/simulate-payment/${orderId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!simRes.ok) {
      const body = await simRes.text();
      throw new Error(`simulate-payment → ${simRes.status}: ${body}`);
    }

    const sim = await simRes.json();
    log('3', `Simülasyon OK (txid: ${sim.simulated ? 'devnet_sim_***' : '?'})`);

    // ── 4. Kart gelene kadar poll et ──────────────────────────────────────────
    log('4', 'Kart bekleniyor…');
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let card = null;
    let lastStatus = '';

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const pollRes = await fetch(`${BASE}/v1/orders/${orderId}`, {
        headers: { 'x-api-key': key.raw },
      });
      const data = await pollRes.json();

      if (data.status !== lastStatus) {
        log('4', `Status: ${data.status} (phase: ${data.phase || '—'})`);
        lastStatus = data.status;
      }

      if (data.phase === 'ready') {
        card = data.card;
        break;
      }

      if (['failed', 'refund_pending', 'refunded', 'expired', 'rejected'].includes(data.status)) {
        throw new Error(`Order terminal durumda: ${data.status} — ${data.error || 'detay yok'}`);
      }
    }

    if (!card) throw new Error(`${POLL_TIMEOUT_MS / 1000}s içinde kart gelmedi`);

    // ── 5. Sonuç ──────────────────────────────────────────────────────────────
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const cardElapsed = ((Date.now() - tPay) / 1000).toFixed(1);

    console.log(`\n${'═'.repeat(55)}`);
    console.log(' KART TESLİM EDİLDİ');
    console.log(`${'═'.repeat(55)}`);
    console.log(` Numara : ${'*'.repeat(12)}${card.number?.slice(-4)}`);
    console.log(` Expiry : ${card.expiry}`);
    console.log(` Brand  : ${card.brand}`);
    console.log(` CVV    : *** (loglanmıyor)`);
    console.log(`${'─'.repeat(55)}`);
    console.log(` Ödeme → Kart : ${cardElapsed}s`);
    console.log(` Toplam       : ${elapsed}s`);
    console.log(`${'═'.repeat(55)}\n`);
  } finally {
    await deleteTestKey(key.id);
    log('cleanup', 'Test API key silindi');
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
