// @ts-check
// Solana payment event handler.
// Called by payments/solana.js when a payment event is detected on-chain.
//
// Flow:
//   1. Agent calls accept_usdc / accept_sol on the Obolus Anchor program.
//   2. payments/solana.js detects the transaction and calls handlePayment.
//   3. This module validates the amount, claims the order, and runs
//      the VCC fulfillment pipeline (getInvoice → payVccOrder → notifyPaid).

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { getInvoice, notifyPaid } = require('./vcc-client');
const solanaSender = require('./payments/solana-sender');
const { scheduleRefund } = require('./fulfillment');
const logger = require('./lib/logger');
const { publicMessage } = require('./lib/sanitize-error');

// Scale decimal string to 9 decimal places (USDC uses 6, SOL uses 9 — use 9 for both)
function toUnits(s) {
  if (s === null || s === undefined || s === '') return 0n;
  const str = String(s).trim();
  const neg = str.startsWith('-');
  const abs = neg ? str.slice(1) : str;
  const [whole, frac = ''] = abs.split('.');
  const paddedFrac = (frac + '000000000').slice(0, 9);
  const value = BigInt(whole || '0') * 1_000_000_000n + BigInt(paddedFrac || '0');
  return neg ? -value : value;
}

function compareDecimal(a, b) {
  const A = toUnits(a);
  const B = toUnits(b);
  if (A > B) return 1;
  if (A < B) return -1;
  return 0;
}

function parseStrictPositiveUnits(s) {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'string') return null;
  const str = s.trim();
  if (str.length === 0) return null;
  if (!/^\d+(\.\d+)?$/.test(str)) return null;
  try {
    const v = toUnits(str);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

function unitsToDecimal(units) {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / 1_000_000_000n;
  const frac = String(abs % 1_000_000_000n).padStart(9, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

function safeErrorMessage(err) {
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  if (typeof err === 'string') return err;
  try {
    if (err instanceof Error && typeof err.message === 'string') return err.message;
    return String(err);
  } catch {
    return '<unstringifiable error>';
  }
}

function recordUnmatchedPayment(row) {
  try {
    db.prepare(
      `INSERT INTO unmatched_payments
         (id, solana_txid, sender_address, payment_asset, amount_usdc, amount_sol, claimed_order_id, reason)
       VALUES (@id, @txid, @sender, @asset, @amountUsdc, @amountSol, @orderId, @reason)`,
    ).run({
      id: uuidv4(),
      txid: row.txid,
      sender: row.senderAddress,
      asset: row.paymentAsset,
      amountUsdc: row.amountUsdc,
      amountSol: row.amountSol,
      orderId: row.orderId,
      reason: row.reason,
    });
    logger.event('payment.unmatched', {
      txid: row.txid,
      reason: row.reason,
      order_id: row.orderId,
      asset: row.paymentAsset,
      amount_usdc: row.amountUsdc,
      amount_sol: row.amountSol,
    });
  } catch (err) {
    console.error(`[payment] failed to record unmatched payment ${row.txid}: ${err.message}`);
  }
}

/**
 * Handle a confirmed Solana payment event.
 * @param {{ txid: string, paymentAsset: 'usdc_solana'|'sol_solana', amountUsdc: string|null, amountSol: string|null, senderAddress: string|null, orderId: string }} params
 */
async function handlePayment({ txid, paymentAsset, amountUsdc, amountSol, senderAddress, orderId }) {
  const order = /** @type {any} */ (db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId));

  if (!order) {
    recordUnmatchedPayment({ txid, senderAddress, paymentAsset, amountUsdc, amountSol, orderId, reason: 'unknown_order' });
    return;
  }

  if (order.status !== 'pending_payment') {
    recordUnmatchedPayment({ txid, senderAddress, paymentAsset, amountUsdc, amountSol, orderId, reason: `order_status_${order.status}` });
    return;
  }

  // Validate amount — reject underpayment, accept overpayment
  let excessUsdc = null;
  if (paymentAsset === 'usdc_solana') {
    const expectedUnits = parseStrictPositiveUnits(order.amount_usdc);
    if (expectedUnits === null) {
      logger.event('payment.corrupt_order_amount', { order_id: orderId });
      recordUnmatchedPayment({ txid, senderAddress, paymentAsset, amountUsdc, amountSol, orderId, reason: 'corrupt_order' });
      return;
    }
    const cmp = compareDecimal(amountUsdc, order.amount_usdc);
    if (cmp < 0) {
      recordUnmatchedPayment({ txid, senderAddress, paymentAsset, amountUsdc, amountSol, orderId, reason: 'underpaid_usdc' });
      return;
    }
    if (cmp > 0) {
      const excess = toUnits(amountUsdc) - toUnits(order.amount_usdc);
      excessUsdc = unitsToDecimal(excess);
      logger.event('payment.usdc_overpaid', { order_id: orderId, expected: order.amount_usdc, paid: amountUsdc, excess: excessUsdc, txid });
    }
  } else if (paymentAsset === 'sol_solana') {
    const expected = order.expected_sol_amount; // column reused for SOL quote
    if (!expected) {
      recordUnmatchedPayment({ txid, senderAddress, paymentAsset, amountUsdc, amountSol, orderId, reason: 'sol_not_quoted' });
      return;
    }
    if (compareDecimal(amountSol, expected) < 0) {
      recordUnmatchedPayment({ txid, senderAddress, paymentAsset, amountUsdc, amountSol, orderId, reason: 'underpaid_sol' });
      return;
    }
  } else {
    recordUnmatchedPayment({ txid, senderAddress, paymentAsset, amountUsdc, amountSol, orderId, reason: 'unknown_asset' });
    return;
  }

  const now = new Date().toISOString();

  // Atomic claim: pending_payment → ordering
  const claimed = db
    .prepare(
      `UPDATE orders
       SET status = 'ordering', payment_asset = ?, solana_txid = ?,
           sender_address = ?, payment_sol_amount = ?,
           excess_usdc = COALESCE(?, excess_usdc), updated_at = ?
       WHERE id = ? AND status = 'pending_payment'`,
    )
    .run(paymentAsset, txid, senderAddress, amountSol, excessUsdc, now, orderId);

  if (claimed.changes === 0) {
    recordUnmatchedPayment({ txid, senderAddress, paymentAsset, amountUsdc, amountSol, orderId, reason: 'duplicate_payment' });
    return;
  }

  try {
    const { vccJobId, callbackNonce } = await getInvoice(
      orderId,
      order.amount_usdc,
      order.request_id,
    );

    // Snapshot SOL/USD rate for margin tracking
    let settlementRate = null;
    try {
      const { getSolUsdPrice } = require('./payments/sol-price');
      settlementRate = String(await getSolUsdPrice());
    } catch { /* non-critical */ }

    db.prepare(
      `UPDATE orders SET vcc_job_id = ?, callback_nonce = ?,
       settlement_xlm_usd_rate = ?, updated_at = ? WHERE id = ?`,
    ).run(vccJobId, callbackNonce, settlementRate, new Date().toISOString(), orderId);

    // VCC sends us the card directly via callback — no on-chain payment to VCC needed
    db.prepare(
      `UPDATE orders SET sol_sent_at = ?, updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), new Date().toISOString(), orderId);

    await notifyPaid(vccJobId);
    db.prepare(`UPDATE orders SET vcc_notified_at = ?, updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(), new Date().toISOString(), orderId,
    );
  } catch (err) {
    const rawMessage = safeErrorMessage(err);
    console.error(`[payment] order ${orderId.slice(0, 8)} fulfillment error: ${rawMessage}`);
    db.prepare(`UPDATE orders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(
      publicMessage(rawMessage), new Date().toISOString(), orderId,
    );
    scheduleRefund(orderId).catch((e) =>
      console.error(`[payment] refund error for ${orderId.slice(0, 8)}: ${safeErrorMessage(e)}`),
    );
  }
}

module.exports = {
  handlePayment,
  _parseStrictPositiveUnits: parseStrictPositiveUnits,
  _safeErrorMessage: safeErrorMessage,
};
