// @ts-check
// Derives the public "agent_state" value shown in the dashboard from an
// api_keys row plus its order history. The stored column only holds
// explicitly-reported transient states ('initializing', 'awaiting_funding',
// 'funded'). 'minted' and 'active' are computed on every read so they
// never drift.

const db = require('../db');

const STATE_LABELS = Object.freeze({
  minted: 'Minted',
  initializing: 'Setting up',
  awaiting_funding: 'Awaiting deposit',
  funded: 'Funded',
  active: 'Active',
  unknown: 'Unknown',
});

const TRANSIENT_STATES = new Set(['initializing', 'awaiting_funding', 'funded']);

const _warnedUnknownStates = new Set();

const _singleCountStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM orders WHERE api_key_id = ? AND status = 'delivered'`,
);

/**
 * @param {any} key
 * @param {number} deliveredCount
 */
function _assemble(key, deliveredCount) {
  if (!key) {
    return {
      state: 'minted',
      label: STATE_LABELS.minted,
      detail: null,
      since: null,
      wallet_public_key: null,
    };
  }

  if (deliveredCount > 0) {
    return {
      state: 'active',
      label: STATE_LABELS.active,
      detail: `${deliveredCount} delivered`,
      since: key.agent_state_at ?? key.last_used_at ?? null,
      wallet_public_key: key.wallet_public_key ?? null,
    };
  }

  if (TRANSIENT_STATES.has(key.agent_state)) {
    return {
      state: key.agent_state,
      label: STATE_LABELS[key.agent_state],
      detail: key.agent_state_detail ?? null,
      since: key.agent_state_at ?? null,
      wallet_public_key: key.wallet_public_key ?? null,
    };
  }

  if (key.agent_state && key.agent_state !== 'minted' && key.agent_state !== 'active') {
    const rawValue = String(key.agent_state);
    if (!_warnedUnknownStates.has(rawValue)) {
      console.warn(
        `[agent-state] unrecognized agent_state=${JSON.stringify(rawValue)} ` +
          `(first seen on api_key_id=${key.id}) — rendering as 'unknown'. ` +
          `Add it to TRANSIENT_STATES or clean the row.`,
      );
      _warnedUnknownStates.add(rawValue);
    }
    return {
      state: 'unknown',
      label: STATE_LABELS.unknown,
      detail: rawValue,
      since: key.agent_state_at ?? null,
      wallet_public_key: key.wallet_public_key ?? null,
    };
  }

  return {
    state: 'minted',
    label: STATE_LABELS.minted,
    detail: null,
    since: key.last_used_at ?? null,
    wallet_public_key: key.wallet_public_key ?? null,
  };
}

/**
 * Batched delivered-count lookup for a list of api_keys ids.
 * @param {Array<string|number>} ids
 * @returns {Promise<Map<string|number, number>>}
 */
async function batchDeliveredCounts(ids) {
  const out = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return out;
  const clean = ids.filter((id) => id !== null && id !== undefined);
  if (clean.length === 0) return out;
  const placeholders = clean.map(() => '?').join(',');
  const rows = /** @type {any[]} */ (
    await db
      .prepare(
        `SELECT api_key_id, COUNT(*) AS n
         FROM orders
         WHERE api_key_id IN (${placeholders}) AND status = 'delivered'
         GROUP BY api_key_id`,
      )
      .all(...clean)
  );
  for (const r of rows) out.set(r.api_key_id, r.n);
  return out;
}

/**
 * Compute the display state for an api_keys row.
 * @param {any} key
 * @param {{ deliveredCount?: number }} [opts]
 * @returns {Promise<{ state: string, label: string, detail: string|null, since: string|null, wallet_public_key: string|null }>}
 */
async function deriveAgentState(key, opts = {}) {
  if (!key) return _assemble(null, 0);
  let deliveredCount;
  if (typeof opts.deliveredCount === 'number' && Number.isFinite(opts.deliveredCount)) {
    deliveredCount = opts.deliveredCount;
  } else {
    const row = /** @type {any} */ (await _singleCountStmt.get(key.id));
    deliveredCount = row?.n ?? 0;
  }
  return _assemble(key, deliveredCount);
}

function _resetWarnedStates() {
  _warnedUnknownStates.clear();
}

module.exports = {
  deriveAgentState,
  batchDeliveredCounts,
  STATE_LABELS,
  _resetWarnedStates,
};
