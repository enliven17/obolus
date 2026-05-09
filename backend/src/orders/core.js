// @ts-check
// Canonical "create an orders row" helper.

const db = require('../db');

/**
 * @typedef {object} InsertPendingPaymentOrderOpts
 * @property {string} id
 * @property {string} amount_usdc
 * @property {string|null} expected_sol_amount
 * @property {string} api_key_id
 * @property {string|null} webhook_url
 * @property {string|null} metadata
 * @property {string} vcc_payment_json
 * @property {string|null} request_id
 * @property {'v1_orders'|'mpp'} [source]
 */

/**
 * @param {InsertPendingPaymentOrderOpts} opts
 * @returns {Promise<void>}
 */
async function insertPendingPaymentOrder(opts) {
  const source = opts.source ?? 'v1_orders';
  await db
    .prepare(
      `INSERT INTO orders (id, status, amount_usdc, expected_sol_amount, api_key_id,
                         webhook_url, metadata, vcc_payment_json, request_id, source)
     VALUES (@id, 'pending_payment', @amount_usdc, @expected_sol_amount, @api_key_id,
             @webhook_url, @metadata, @vcc_payment_json, @request_id, @source)`,
    )
    .run({
      id: opts.id,
      amount_usdc: opts.amount_usdc,
      expected_sol_amount: opts.expected_sol_amount,
      api_key_id: opts.api_key_id,
      webhook_url: opts.webhook_url,
      metadata: opts.metadata,
      vcc_payment_json: opts.vcc_payment_json,
      request_id: opts.request_id,
      source,
    });
}

module.exports = { insertPendingPaymentOrder };
