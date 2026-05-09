// @ts-check
// Refund and webhook delivery for the obolus backend.

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { assertSafeUrl } = require('./lib/ssrf');
const { sendUsdc, sendSol } = require('./payments/solana-sender');
const { event: bizEvent } = require('./lib/logger');

async function isFrozen() {
  return (
    /** @type {any} */ (
      await db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get()
    )?.value === '1'
  );
}

function redactCardFields(payload) {
  if (!payload || typeof payload !== 'object' || !payload.card) return payload;
  return { ...payload, card: { ...payload.card, number: null, cvv: null, expiry: null } };
}

const WEBHOOK_RETRY_DELAYS_MS = [30_000, 5 * 60_000, 30 * 60_000];
const MAX_WEBHOOK_ATTEMPTS = 3;

const CB_THRESHOLD = 5;
const CB_WINDOW_MS = 60_000;
const CB_COOLDOWN_MS = 5 * 60_000;
const circuitBreakerState = new Map();

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function circuitIsOpen(origin) {
  const s = circuitBreakerState.get(origin);
  if (!s) return false;
  return Date.now() < s.openedUntil;
}

function recordCircuitFailure(origin) {
  if (!origin) return;
  let s = circuitBreakerState.get(origin);
  if (!s) {
    s = { failures: [], openedUntil: 0 };
    circuitBreakerState.set(origin, s);
  }
  const now = Date.now();
  s.failures = s.failures.filter((ts) => now - ts < CB_WINDOW_MS);
  s.failures.push(now);
  if (s.failures.length >= CB_THRESHOLD) {
    s.openedUntil = now + CB_COOLDOWN_MS;
    bizEvent('webhook.circuit_opened', {
      origin,
      failures: s.failures.length,
      reopen_at: new Date(s.openedUntil).toISOString(),
    });
    s.failures = [];
  }
}

function recordCircuitSuccess(origin) {
  if (!origin) return;
  const s = circuitBreakerState.get(origin);
  if (s) {
    s.failures = [];
    if (Date.now() >= s.openedUntil) s.openedUntil = 0;
  }
}

async function fireWebhook(url, payload, webhookSecret, _log, context = {}) {
  const origin = getOrigin(url);
  if (origin && circuitIsOpen(origin)) throw new Error(`webhook circuit open for ${origin}`);

  await assertSafeUrl(url);
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };

  let signatureHeader = null;
  if (webhookSecret) {
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', webhookSecret).update(`${ts}.${body}`).digest('hex');
    headers['X-Obolus-Signature'] = `sha256=${sig}`;
    headers['X-Obolus-Timestamp'] = ts;
    signatureHeader = headers['X-Obolus-Signature'];
  }

  const startedAt = Date.now();
  const { recordWebhookDelivery } = require('./lib/webhook-log');
  let responseStatus = null;
  let responseBodyText = null;
  let deliveryError = null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    responseStatus = res.status;
    try {
      responseBodyText = (await res.clone().text()).slice(0, 2000);
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      recordCircuitFailure(origin);
      deliveryError = `HTTP ${res.status}`;
      throw new Error(`webhook HTTP ${res.status}`);
    }
    recordCircuitSuccess(origin);
  } catch (err) {
    if (!/circuit open/.test(err.message)) recordCircuitFailure(origin);
    deliveryError = deliveryError || err.message;
    throw err;
  } finally {
    await recordWebhookDelivery({
      url,
      method: 'POST',
      requestBody: redactCardFields(payload),
      responseStatus: responseStatus ?? undefined,
      responseBody: responseBodyText ?? undefined,
      latencyMs: Date.now() - startedAt,
      error: deliveryError ?? undefined,
      signature: signatureHeader ?? undefined,
      dashboardId: context.dashboardId ?? undefined,
      apiKeyId: context.apiKeyId ?? undefined,
    });
  }
}

async function enqueueWebhook(url, payload, webhookSecret) {
  let deliveryErr;
  try {
    await fireWebhook(url, payload, webhookSecret, null);
    return;
  } catch (err) {
    deliveryErr = err;
  }
  const nextAttempt = new Date(Date.now() + WEBHOOK_RETRY_DELAYS_MS[0]).toISOString();
  const errMessage = /** @type {Error} */ (deliveryErr)?.message || String(deliveryErr);
  try {
    await db
      .prepare(
        `INSERT INTO webhook_queue (id, url, payload, secret, attempts, next_attempt, last_error)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        uuidv4(),
        url,
        JSON.stringify(redactCardFields(payload)),
        webhookSecret || null,
        nextAttempt,
        errMessage,
      );
  } catch (insertErr) {
    bizEvent('webhook.queue_insert_failed', {
      url,
      original_delivery_error: errMessage,
      insert_error: /** @type {Error} */ (insertErr)?.message || String(insertErr),
    });
    console.error(
      `[webhook] failed to persist ${url} to webhook_queue after delivery error — delivery LOST: original=${errMessage}; insert=${/** @type {Error} */ (insertErr)?.message}`,
    );
  }
}

function isValidRefundAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return false;
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return false;
  return parseFloat(s) > 0;
}

function toLamportsOrZero(s) {
  if (s === null || s === undefined || s === '') return 0n;
  const str = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) return 0n;
  const [whole, frac = ''] = str.split('.');
  const paddedFrac = (frac + '0000000').slice(0, 7);
  return BigInt(whole || '0') * 10_000_000n + BigInt(paddedFrac || '0');
}

function lamportsToDecimal(lamports) {
  const whole = lamports / 10_000_000n;
  const frac = String(lamports % 10_000_000n).padStart(7, '0');
  return `${whole}.${frac}`;
}

function computeUsdcRefundAmount(amountUsdc, excessUsdc) {
  return lamportsToDecimal(toLamportsOrZero(amountUsdc) + toLamportsOrZero(excessUsdc));
}

async function recordRefundSendFailure(orderId, asset, amount, err) {
  const txHash = /** @type {any} */ (err)?.txHash || null;
  const solanaStatus = /** @type {any} */ (err)?.solanaStatus || 'legacy';
  if (txHash) {
    await db
      .prepare(
        `UPDATE orders
       SET refund_solana_txid = COALESCE(refund_solana_txid, @txid),
           updated_at = NOW()
       WHERE id = @id`,
      )
      .run({ id: orderId, txid: txHash });
  }
  bizEvent('refund.send_failed', {
    order_id: orderId,
    asset,
    amount,
    solana_status: solanaStatus,
    tx_hash: txHash,
    error: /** @type {Error} */ (err)?.message || String(err),
  });
  const reviewTag =
    solanaStatus === 'unknown' || solanaStatus === 'applied_failed'
      ? 'VERIFY_ON_CHAIN'
      : 'SAFE_TO_RETRY';
  console.log(
    `[refund] ${orderId}: ${asset} refund failed [${solanaStatus}] [${reviewTag}] txHash=${txHash || 'none'}: ${/** @type {Error} */ (err)?.message} — remains refund_pending`,
  );
}

async function scheduleRefund(orderId) {
  if (await isFrozen()) {
    bizEvent('refund.skipped_frozen', { order_id: orderId });
    console.log(`[refund] ${orderId}: system frozen — refund deferred for ops review`);
    return;
  }

  const claimed = await db
    .prepare(
      `UPDATE orders SET status = 'refund_pending', updated_at = NOW()
       WHERE id = ? AND status NOT IN ('refund_pending', 'refunded')`,
    )
    .run(orderId);

  if (claimed.changes === 0) {
    console.log(`[refund] ${orderId}: already refunding or refunded — skipping`);
    return;
  }

  const order = /** @type {any} */ (
    await db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId)
  );
  if (!order) return;

  if (!order.sender_address) {
    console.log(
      `[refund] ${orderId}: no sender_address — left as refund_pending for manual action`,
    );
    return;
  }

  const asset = order.payment_asset;
  const isXlm = asset === 'sol_solana' || asset === 'sol';
  const isUsdc = asset === 'usdc_solana' || asset === 'usdc';
  if (!isXlm && !isUsdc) {
    bizEvent('refund.unknown_asset', { order_id: orderId, asset });
    console.log(
      `[refund] ${orderId}: unknown payment_asset '${asset}' — remains refund_pending for manual action`,
    );
    return;
  }

  if (isXlm) {
    const solAmount = order.payment_sol_amount;
    if (!isValidRefundAmount(solAmount)) {
      console.log(
        `[refund] ${orderId}: invalid payment_sol_amount '${solAmount}' — order remains refund_pending`,
      );
      return;
    }
    try {
      const txHash = await sendSol({
        destination: order.sender_address,
        amount: solAmount,
        memo: `refund:${orderId.slice(0, 18)}`,
      });
      await db
        .prepare(
          `UPDATE orders SET status = 'refunded', refund_solana_txid = @txid, updated_at = NOW() WHERE id = @id`,
        )
        .run({ id: orderId, txid: txHash });
      bizEvent('refund.sent', { order_id: orderId, asset: 'sol', amount: solAmount, txid: txHash });
    } catch (err) {
      await recordRefundSendFailure(orderId, 'sol', solAmount, err);
    }
  } else {
    if (!isValidRefundAmount(order.amount_usdc)) {
      console.log(
        `[refund] ${orderId}: invalid amount_usdc '${order.amount_usdc}' — order remains refund_pending`,
      );
      return;
    }
    const refundAmount = computeUsdcRefundAmount(order.amount_usdc, order.excess_usdc);
    const amountToSend = isValidRefundAmount(refundAmount) ? refundAmount : order.amount_usdc;
    try {
      const txHash = await sendUsdc({
        destination: order.sender_address,
        amount: amountToSend,
        memo: `refund:${orderId.slice(0, 18)}`,
      });
      await db
        .prepare(
          `UPDATE orders SET status = 'refunded', refund_solana_txid = @txid, updated_at = NOW() WHERE id = @id`,
        )
        .run({ id: orderId, txid: txHash });
      bizEvent('refund.sent', {
        order_id: orderId,
        asset: 'usdc',
        amount: amountToSend,
        quoted_amount: order.amount_usdc,
        excess_amount: order.excess_usdc || null,
        txid: txHash,
      });
    } catch (err) {
      await recordRefundSendFailure(orderId, 'usdc', amountToSend, err);
    }
  }
}

module.exports = {
  isFrozen,
  scheduleRefund,
  enqueueWebhook,
  fireWebhook,
  redactCardFields,
  WEBHOOK_RETRY_DELAYS_MS,
  MAX_WEBHOOK_ATTEMPTS,
  _computeUsdcRefundAmount: computeUsdcRefundAmount,
  _recordCircuitSuccess: recordCircuitSuccess,
  _recordCircuitFailure: recordCircuitFailure,
  _circuitIsOpen: circuitIsOpen,
  _circuitBreakerState: circuitBreakerState,
};
