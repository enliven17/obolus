// @ts-check
// Shared order-stats query builder.

const db = require('../db');

const MAX_SCOPE_IDS = 1000;

function emptyStats() {
  return {
    total_orders: 0,
    total_gmv: 0,
    delivered: 0,
    failed: 0,
    refunded: 0,
    pending: 0,
    in_progress: 0,
    refund_pending: 0,
    expired: 0,
    rejected: 0,
    awaiting_approval: 0,
  };
}

/**
 * @param {{ apiKeyIds?: string[] }} [opts]
 * @returns {Promise<any>}
 */
async function getOrderStats(opts = {}) {
  const { apiKeyIds } = opts;

  if (apiKeyIds !== undefined && !Array.isArray(apiKeyIds)) {
    throw new TypeError(
      `getOrderStats: apiKeyIds must be an array or undefined, got ${typeof apiKeyIds}`,
    );
  }
  if (apiKeyIds !== undefined && apiKeyIds.length === 0) return emptyStats();
  if (apiKeyIds !== undefined && apiKeyIds.length > MAX_SCOPE_IDS) {
    throw new RangeError(
      `getOrderStats: apiKeyIds length ${apiKeyIds.length} exceeds MAX_SCOPE_IDS=${MAX_SCOPE_IDS}`,
    );
  }

  let where = '';
  /** @type {any[]} */
  const params = [];
  if (apiKeyIds && apiKeyIds.length > 0) {
    const placeholders = apiKeyIds.map(() => '?').join(',');
    where = `WHERE api_key_id IN (${placeholders})`;
    params.push(...apiKeyIds);
  }

  return /** @type {any} */ (
    await db
      .prepare(
        `SELECT
          COUNT(*) AS total_orders,
          COALESCE(SUM(CASE WHEN status = 'delivered' THEN CAST(amount_usdc AS DOUBLE PRECISION) ELSE 0 END), 0) AS total_gmv,
          COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END), 0) AS refunded,
          COALESCE(SUM(CASE WHEN status = 'pending_payment' THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN status IN ('ordering','payment_confirmed','claim_received','stage1_done') THEN 1 ELSE 0 END), 0) AS in_progress,
          COALESCE(SUM(CASE WHEN status = 'refund_pending' THEN 1 ELSE 0 END), 0) AS refund_pending,
          COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END), 0) AS expired,
          COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
          COALESCE(SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END), 0) AS awaiting_approval
         FROM orders ${where}`,
      )
      .get(...params)
  );
}

module.exports = { getOrderStats };
