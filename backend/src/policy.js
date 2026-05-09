// @ts-check
// Policy engine — evaluates spend controls before any card is issued.

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { event: bizEvent } = require('./lib/logger');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * @param {string} apiKeyId
 * @param {string} amountUsdc
 * @param {{ persist?: boolean }} [opts]
 * @returns {Promise<{ decision: 'approved'|'blocked'|'pending_approval', rule: string, reason: string }>}
 */
async function checkPolicy(apiKeyId, amountUsdc, opts = {}) {
  const persist = opts.persist !== false;
  const finalise = async (decision, rule, reason) =>
    persist
      ? await _decide(apiKeyId, null, amountUsdc, decision, rule, reason)
      : { decision, rule, reason };

  const key = /** @type {any} */ (
    await db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(apiKeyId)
  );
  if (!key) return await finalise('blocked', 'key_not_found', 'API key not found');

  const amount = parseFloat(amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) {
    return await finalise(
      'blocked',
      'invalid_amount',
      `Amount must be a positive finite number (got: ${amountUsdc}).`,
    );
  }

  // 1. Suspension
  if (key.suspended) {
    return await finalise('blocked', 'suspended', 'This agent is suspended by the account owner.');
  }

  // 2. Single-transaction hard cap
  if (key.policy_single_tx_limit_usdc !== null && key.policy_single_tx_limit_usdc !== undefined) {
    const cap = parseFloat(key.policy_single_tx_limit_usdc);
    if (!Number.isFinite(cap) || cap < 0) {
      bizEvent('policy.corrupt', {
        api_key_id: apiKeyId,
        field: 'policy_single_tx_limit_usdc',
        stored: String(key.policy_single_tx_limit_usdc),
      });
      return await finalise(
        'blocked',
        'policy_corrupt_single_tx',
        'Account policy (per-transaction limit) is misconfigured — contact support.',
      );
    }
    if (amount > cap) {
      return await finalise(
        'blocked',
        'single_tx_hard_cap',
        `Transaction $${amount.toFixed(2)} exceeds the per-transaction hard cap of $${cap.toFixed(2)}.`,
      );
    }
  }

  // 3. After-hours check (UTC)
  if (key.policy_allowed_hours) {
    try {
      const { start, end } = JSON.parse(key.policy_allowed_hours);
      const parseHHMM = (label, value) => {
        if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
          throw new Error(`${label} must be HH:MM (got: ${JSON.stringify(value)})`);
        }
        const [h, m] = value.split(':').map((s) => parseInt(s, 10));
        if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error(`${label} hour out of range`);
        if (!Number.isInteger(m) || m < 0 || m > 59)
          throw new Error(`${label} minute out of range`);
        return h * 60 + m;
      };
      const startMins = parseHHMM('start', start);
      const endMins = parseHHMM('end', end);
      const now = new Date();
      const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
      const inWindow =
        startMins <= endMins
          ? nowMins >= startMins && nowMins < endMins
          : nowMins >= startMins || nowMins < endMins;
      if (!inWindow) {
        const nowStr = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;
        return await finalise(
          'blocked',
          'after_hours',
          `Transactions are only allowed ${start}–${end} UTC. Current time: ${nowStr}.`,
        );
      }
    } catch (err) {
      bizEvent('policy.corrupt', {
        api_key_id: apiKeyId,
        field: 'policy_allowed_hours',
        error: err.message,
      });
      return await finalise(
        'blocked',
        'policy_corrupt_hours',
        'Account policy (allowed hours) is misconfigured — contact support.',
      );
    }
  }

  // 4. Blocked day of week
  if (key.policy_allowed_days) {
    try {
      const allowed = JSON.parse(key.policy_allowed_days);
      if (!Array.isArray(allowed)) throw new Error('not an array');
      for (const entry of allowed) {
        if (!Number.isInteger(entry) || entry < 0 || entry > 6) {
          throw new Error(`entry must be an integer in [0,6], got: ${JSON.stringify(entry)}`);
        }
      }
      const today = new Date().getUTCDay();
      if (!allowed.includes(today)) {
        return await finalise(
          'blocked',
          'blocked_day',
          `Transactions are not allowed on ${DAY_NAMES[today]}.`,
        );
      }
    } catch (err) {
      bizEvent('policy.corrupt', {
        api_key_id: apiKeyId,
        field: 'policy_allowed_days',
        error: err.message,
      });
      return await finalise(
        'blocked',
        'policy_corrupt_days',
        'Account policy (allowed days) is misconfigured — contact support.',
      );
    }
  }

  // 5. Daily spend limit
  if (key.policy_daily_limit_usdc !== null && key.policy_daily_limit_usdc !== undefined) {
    const dailyLimit = parseFloat(key.policy_daily_limit_usdc);
    if (!Number.isFinite(dailyLimit) || dailyLimit < 0) {
      bizEvent('policy.corrupt', {
        api_key_id: apiKeyId,
        field: 'policy_daily_limit_usdc',
        stored: String(key.policy_daily_limit_usdc),
      });
      return await finalise(
        'blocked',
        'policy_corrupt_daily',
        'Account policy (daily limit) is misconfigured — contact support.',
      );
    }
    const row = /** @type {any} */ (
      await db
        .prepare(
          `SELECT COALESCE(SUM(CAST(amount_usdc AS DOUBLE PRECISION)), 0) AS total
           FROM orders
           WHERE api_key_id = ?
             AND status NOT IN ('expired', 'rejected')
             AND created_at::date = CURRENT_DATE`,
        )
        .get(apiKeyId)
    );
    const spentToday = parseFloat(row.total);
    if (spentToday + amount > dailyLimit) {
      return await finalise(
        'blocked',
        'daily_limit_exceeded',
        `Daily limit of $${dailyLimit.toFixed(2)} would be exceeded. Spent today: $${spentToday.toFixed(2)}, requested: $${amount.toFixed(2)}.`,
      );
    }
  }

  // 6. Approval threshold
  if (
    key.policy_require_approval_above_usdc !== null &&
    key.policy_require_approval_above_usdc !== undefined
  ) {
    const threshold = parseFloat(key.policy_require_approval_above_usdc);
    if (!Number.isFinite(threshold) || threshold < 0) {
      bizEvent('policy.corrupt', {
        api_key_id: apiKeyId,
        field: 'policy_require_approval_above_usdc',
        stored: String(key.policy_require_approval_above_usdc),
      });
      return await finalise(
        'blocked',
        'policy_corrupt_approval',
        'Account policy (approval threshold) is misconfigured — contact support.',
      );
    }
    if (amount > threshold) {
      return {
        decision: 'pending_approval',
        rule: 'approval_threshold',
        reason: `Transaction of $${amount.toFixed(2)} requires owner approval (threshold: $${threshold.toFixed(2)}).`,
      };
    }
  }

  // 7. All checks passed
  return await finalise('approved', 'all_checks_passed', 'Transaction approved by policy.');
}

/**
 * @param {string} apiKeyId
 * @param {string|null} orderId
 * @param {string} amountUsdc
 * @param {string} decision
 * @param {string} rule
 * @param {string} reason
 */
async function recordDecision(apiKeyId, orderId, amountUsdc, decision, rule, reason) {
  await db
    .prepare(
      `INSERT INTO policy_decisions (id, api_key_id, order_id, decision, rule, reason, amount_usdc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(uuidv4(), apiKeyId, orderId || null, decision, rule, reason, amountUsdc || null);
  return { decision, rule, reason };
}

async function _decide(apiKeyId, orderId, amountUsdc, decision, rule, reason) {
  return recordDecision(apiKeyId, orderId, amountUsdc, decision, rule, reason);
}

module.exports = { checkPolicy, recordDecision };
