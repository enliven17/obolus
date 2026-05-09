// @ts-check
// Alert rules: persisted per-dashboard rules evaluated on a background tick.

/** @type {any} */
const db = require('../db');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

const SYSTEM_KINDS = /** @type {ReadonlySet<string>} */ (
  new Set(['ctx_auth_dead', 'circuit_breaker_frozen'])
);
const USER_KINDS = /** @type {ReadonlySet<string>} */ (
  new Set(['failure_rate_high', 'spend_over', 'agent_balance_low'])
);

/** @param {string} kind */ function isSystemKind(kind) {
  return SYSTEM_KINDS.has(kind);
}
/** @param {string} kind */ function isUserKind(kind) {
  return USER_KINDS.has(kind);
}

const CONFIG_SCHEMAS = /** @type {Record<string, Record<string, {min: number, max: number}>>} */ ({
  failure_rate_high: { windowMinutes: { min: 1, max: 10080 }, thresholdPct: { min: 1, max: 100 } },
  spend_over: {
    windowMinutes: { min: 1, max: 10080 },
    thresholdUsd: { min: 0.01, max: 1_000_000 },
  },
  agent_balance_low: { thresholdRemainingUsd: { min: 0.01, max: 1_000_000 } },
  ctx_auth_dead: {},
  circuit_breaker_frozen: {},
});

function validateConfigForKind(kind, config) {
  if (config === undefined || config === null) return;
  if (typeof config !== 'object' || Array.isArray(config))
    throw new Error(`config must be a plain object (got: ${typeof config})`);
  const schema = CONFIG_SCHEMAS[kind];
  if (!schema) return;
  const cfg = /** @type {Record<string, unknown>} */ (config);
  for (const [key, { min, max }] of Object.entries(schema)) {
    if (cfg[key] === undefined) continue;
    const n = Number(cfg[key]);
    if (!Number.isFinite(n))
      throw new Error(`config.${key} must be a finite number (got: ${String(cfg[key])})`);
    if (n < min || n > max)
      throw new Error(`config.${key} must be between ${min} and ${max} (got: ${String(cfg[key])})`);
  }
}

/**
 * @template {{ kind: string }} R
 * @param {R[]} rules @param {boolean} isPlatformOwner @returns {R[]}
 */
function filterByVisibility(rules, isPlatformOwner) {
  if (isPlatformOwner) return rules;
  return rules.filter((r) => isUserKind(r.kind));
}

function safeParse(s) {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function safeNum(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

/** @param {string} dashboardId @param {{ isPlatformOwner?: boolean }} [opts] */
async function listRules(dashboardId, opts = {}) {
  const rows = /** @type {any[]} */ (
    await db
      .prepare(
        `SELECT id, dashboard_id, name, kind, config, enabled, snoozed_until,
                notify_email, notify_webhook_url, created_at, updated_at
         FROM alert_rules WHERE dashboard_id = ? ORDER BY created_at ASC`,
      )
      .all(dashboardId)
  );
  const decoded = rows.map((r) => ({ ...r, config: safeParse(r.config), enabled: !!r.enabled }));
  return filterByVisibility(decoded, !!opts.isPlatformOwner);
}

async function createRule(input) {
  if (!isSystemKind(input.kind) && !isUserKind(input.kind))
    throw new Error(`Unknown alert rule kind: ${input.kind}`);
  if (isSystemKind(input.kind) && !input.isPlatformOwner)
    throw new Error(`System alert rules can only be created by the platform owner`);
  validateConfigForKind(input.kind, input.config);
  const id = uuidv4();
  await db
    .prepare(
      `INSERT INTO alert_rules (id, dashboard_id, name, kind, config, enabled, notify_email, notify_webhook_url)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      input.dashboardId,
      input.name,
      input.kind,
      JSON.stringify(input.config ?? {}),
      input.notifyEmail ?? null,
      input.notifyWebhookUrl ?? null,
    );
  return (await listRules(input.dashboardId, { isPlatformOwner: true })).find((r) => r.id === id);
}

async function updateRule(dashboardId, id, patch, opts = {}) {
  const existing = /** @type {any} */ (
    await db
      .prepare(`SELECT id, kind FROM alert_rules WHERE id = ? AND dashboard_id = ?`)
      .get(id, dashboardId)
  );
  if (!existing) return null;
  if (isSystemKind(existing.kind) && !opts.isPlatformOwner)
    throw new Error('System alert rules can only be modified by the platform owner');
  const fields = [];
  /** @type {Record<string, unknown>} */
  const params = { id, dashboard_id: dashboardId };
  if (patch.name !== undefined) {
    fields.push('name = @name');
    params.name = patch.name;
  }
  if (patch.config !== undefined) {
    validateConfigForKind(existing.kind, patch.config);
    fields.push('config = @config');
    params.config = JSON.stringify(patch.config);
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = @enabled');
    params.enabled = patch.enabled ? 1 : 0;
  }
  if (patch.snoozedUntil !== undefined) {
    fields.push('snoozed_until = @snoozed_until');
    params.snoozed_until = patch.snoozedUntil;
  }
  if (patch.notifyEmail !== undefined) {
    fields.push('notify_email = @notify_email');
    params.notify_email = patch.notifyEmail;
  }
  if (patch.notifyWebhookUrl !== undefined) {
    fields.push('notify_webhook_url = @notify_webhook_url');
    params.notify_webhook_url = patch.notifyWebhookUrl;
  }
  if (fields.length === 0)
    return (await listRules(dashboardId, { isPlatformOwner: true })).find((r) => r.id === id);
  fields.push(`updated_at = NOW()`);
  await db
    .prepare(
      `UPDATE alert_rules SET ${fields.join(', ')} WHERE id = @id AND dashboard_id = @dashboard_id`,
    )
    .run(params);
  return (await listRules(dashboardId, { isPlatformOwner: true })).find((r) => r.id === id);
}

async function deleteRule(dashboardId, id, opts = {}) {
  const existing = /** @type {any} */ (
    await db
      .prepare(`SELECT id, kind FROM alert_rules WHERE id = ? AND dashboard_id = ?`)
      .get(id, dashboardId)
  );
  if (!existing) return false;
  if (isSystemKind(existing.kind) && !opts.isPlatformOwner)
    throw new Error('System alert rules can only be deleted by the platform owner');
  const result = await db
    .prepare(`DELETE FROM alert_rules WHERE id = ? AND dashboard_id = ?`)
    .run(id, dashboardId);
  return result.changes > 0;
}

/** @param {string} dashboardId @param {{ limit?: number; isPlatformOwner?: boolean }} [opts] */
async function listFirings(dashboardId, opts = {}) {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
  const rows = /** @type {any[]} */ (
    await db
      .prepare(
        `SELECT f.id, f.rule_id, f.fired_at, f.context, f.notified, r.name AS rule_name, r.kind
         FROM alert_firings f LEFT JOIN alert_rules r ON r.id = f.rule_id
         WHERE f.dashboard_id = ?
         ORDER BY f.id DESC LIMIT ?`,
      )
      .all(dashboardId, limit)
  );
  const decoded = rows.map((r) => ({
    ...r,
    context: safeParse(r.context),
    notified: !!r.notified,
  }));
  return decoded.filter((r) => {
    if (!r.kind) return true;
    if (isSystemKind(r.kind) && !opts.isPlatformOwner) return false;
    return true;
  });
}

async function seedDefaultRules(dashboardId, opts = {}) {
  const existing = /** @type {any} */ (
    await db
      .prepare(`SELECT COUNT(*) AS c FROM alert_rules WHERE dashboard_id = ?`)
      .get(dashboardId)
  );
  if (existing.c > 0) return;
  if (opts.isPlatformOwner) {
    await createRule({
      dashboardId,
      name: 'CTX auth expired',
      kind: 'ctx_auth_dead',
      config: {},
      isPlatformOwner: true,
    });
    await createRule({
      dashboardId,
      name: 'Fulfillment frozen',
      kind: 'circuit_breaker_frozen',
      config: {},
      isPlatformOwner: true,
    });
  }
  await createRule({
    dashboardId,
    name: 'My failure rate over 20% (last 30m)',
    kind: 'failure_rate_high',
    config: { windowMinutes: 30, thresholdPct: 20 },
    isPlatformOwner: !!opts.isPlatformOwner,
  });
  await createRule({
    dashboardId,
    name: 'My spend over $100 (last hour)',
    kind: 'spend_over',
    config: { windowMinutes: 60, thresholdUsd: 100 },
    isPlatformOwner: !!opts.isPlatformOwner,
  });
}

/** @param {string} dashboardId @param {{ now?: number }} [opts] */
async function evaluateRules(dashboardId, opts = {}) {
  const rules = (await listRules(dashboardId, { isPlatformOwner: true })).filter((r) => r.enabled);
  const now = opts.now ?? Date.now();
  const firings = [];
  const cooldownMinutes = DEFAULT_COOLDOWN_MS / 60000;

  for (const rule of rules) {
    try {
      if (rule.snoozed_until && Date.parse(rule.snoozed_until) > now) continue;
      const recent = /** @type {any} */ (
        await db
          .prepare(
            `SELECT 1 AS ok FROM alert_firings
             WHERE rule_id = ? AND fired_at > NOW() - INTERVAL '${cooldownMinutes} minutes'
             LIMIT 1`,
          )
          .get(rule.id)
      );
      if (recent) continue;
      const result = await evaluate(rule, dashboardId, now);
      if (result.tripped) {
        await db
          .prepare(`INSERT INTO alert_firings (rule_id, dashboard_id, context) VALUES (?, ?, ?)`)
          .run(rule.id, dashboardId, JSON.stringify(result.context));
        firings.push({ rule, context: result.context });
      }
    } catch (err) {
      const { event: bizEvent } = safeRequire('./logger');
      if (typeof bizEvent === 'function') {
        bizEvent('alerts.rule_evaluate_failed', {
          rule_id: rule.id,
          rule_kind: rule.kind,
          dashboard_id: dashboardId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      console.error(
        `[alerts] rule ${rule.id} (${rule.kind}) threw during evaluation — skipping: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (firings.length > 0) {
    for (const f of firings) {
      void deliverFiring(dashboardId, f.rule, f.context).catch((err) => {
        console.error(`[alerts] notify error for ${f.rule.id}: ${err.message}`);
      });
    }
  }
  return firings;
}

async function deliverFiring(dashboardId, rule, context) {
  const summary = `${rule.name}: ${JSON.stringify(context)}`;
  let delivered = false;
  if (rule.notify_email) {
    const { sendAlertEmail } = safeRequire('./email');
    if (typeof sendAlertEmail === 'function') {
      try {
        await sendAlertEmail({
          to: rule.notify_email,
          subject: `obolus alert: ${rule.name}`,
          body: summary,
        });
        delivered = true;
      } catch (err) {
        console.error(`[alerts] email notify failed: ${err.message}`);
      }
    }
  }
  if (rule.notify_webhook_url) {
    const fulfillment = safeRequire('../fulfillment');
    if (typeof fulfillment.fireWebhook === 'function') {
      try {
        await fulfillment.fireWebhook(
          rule.notify_webhook_url,
          {
            type: 'alert.firing',
            rule_id: rule.id,
            rule_name: rule.name,
            kind: rule.kind,
            context,
            dashboard_id: dashboardId,
            fired_at: new Date().toISOString(),
          },
          null,
          null,
          { dashboardId },
        );
        delivered = true;
      } catch (err) {
        console.error(`[alerts] webhook notify failed: ${err.message}`);
      }
    }
  }
  if (!delivered && isSystemKind(rule.kind)) {
    const { notifyOps } = safeRequire('./notify');
    if (typeof notifyOps === 'function') void notifyOps({ type: 'frozen', error: summary });
  }
}

function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return {};
  }
}

async function evaluate(rule, dashboardId, now) {
  switch (rule.kind) {
    case 'ctx_auth_dead':
      return { tripped: await isCtxAuthDead(), context: { at: new Date(now).toISOString() } };
    case 'circuit_breaker_frozen':
      return { tripped: await isCircuitFrozen(), context: { at: new Date(now).toISOString() } };
    case 'failure_rate_high':
      return evaluateFailureRate(rule.config, dashboardId, now);
    case 'spend_over':
      return evaluateSpendOver(rule.config, dashboardId, now);
    case 'agent_balance_low':
      return evaluateAgentBalanceLow(rule.config, dashboardId);
    default:
      return { tripped: false, context: { reason: `unknown_kind_${rule.kind}` } };
  }
}

async function isCtxAuthDead() {
  const row = /** @type {any} */ (
    await db.prepare(`SELECT value FROM system_state WHERE key = 'ctx_refresh_token'`).get()
  );
  return !row || !row.value;
}

async function isCircuitFrozen() {
  const row = /** @type {any} */ (
    await db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get()
  );
  return !!(row && String(row.value) === '1');
}

async function evaluateFailureRate(config, dashboardId, now) {
  const windowMinutes = safeNum(config.windowMinutes, 30);
  const thresholdPct = safeNum(config.thresholdPct, 20);
  const cutoffIso = new Date(now - windowMinutes * 60 * 1000).toISOString();
  const row = /** @type {any} */ (
    await db
      .prepare(
        `SELECT
           SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN o.status IN ('failed','refunded','rejected') THEN 1 ELSE 0 END) AS failed
         FROM orders o
         JOIN api_keys k ON o.api_key_id = k.id
         WHERE k.dashboard_id = ? AND o.created_at > ?`,
      )
      .get(dashboardId, cutoffIso)
  );
  const delivered = Number(row?.delivered || 0);
  const failed = Number(row?.failed || 0);
  const total = delivered + failed;
  if (total < 5) return { tripped: false, context: { total } };
  const rate = (failed / total) * 100;
  return {
    tripped: rate >= thresholdPct,
    context: { rate: rate.toFixed(1), threshold: thresholdPct, delivered, failed, windowMinutes },
  };
}

async function evaluateSpendOver(config, dashboardId, now) {
  const windowMinutes = safeNum(config.windowMinutes, 60);
  const thresholdUsd = safeNum(config.thresholdUsd, 100);
  const cutoffIso = new Date(now - windowMinutes * 60 * 1000).toISOString();
  const row = /** @type {any} */ (
    await db
      .prepare(
        `SELECT SUM(CAST(o.amount_usdc AS DOUBLE PRECISION)) AS total
         FROM orders o
         JOIN api_keys k ON o.api_key_id = k.id
         WHERE k.dashboard_id = ? AND o.status = 'delivered' AND o.created_at > ?`,
      )
      .get(dashboardId, cutoffIso)
  );
  const total = Number(row?.total || 0);
  return {
    tripped: total >= thresholdUsd,
    context: { spend: total.toFixed(2), threshold: thresholdUsd, windowMinutes },
  };
}

async function evaluateAgentBalanceLow(config, dashboardId) {
  const thresholdRemainingUsd = safeNum(config.thresholdRemainingUsd, 10);
  const rows = /** @type {any[]} */ (
    await db
      .prepare(
        `SELECT id, label, spend_limit_usdc, total_spent_usdc
         FROM api_keys WHERE dashboard_id = ? AND spend_limit_usdc IS NOT NULL`,
      )
      .all(dashboardId)
  );
  const lowAgents = [];
  for (const r of rows) {
    const limit = parseFloat(r.spend_limit_usdc);
    const spent = parseFloat(r.total_spent_usdc || '0');
    if (!isFinite(limit) || !isFinite(spent)) continue;
    const remaining = limit - spent;
    if (remaining <= thresholdRemainingUsd) lowAgents.push({ id: r.id, label: r.label, remaining });
  }
  return {
    tripped: lowAgents.length > 0,
    context: { lowAgents, threshold: thresholdRemainingUsd },
  };
}

module.exports = {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  listFirings,
  seedDefaultRules,
  evaluateRules,
  isSystemKind,
  isUserKind,
  SYSTEM_KINDS: [...SYSTEM_KINDS],
  USER_KINDS: [...USER_KINDS],
  KNOWN_KINDS: [...SYSTEM_KINDS, ...USER_KINDS],
};
