// @ts-check
// Audit log helper. Any mutating dashboard action calls recordAudit()
// with a structured event that includes the actor, the resource, and
// arbitrary details JSON.

/** @type {any} */
const db = require('../db');
const { normalizeRole } = require('./permissions');

const MAX_DETAILS_BYTES = 16 * 1024;
const MAX_LIST_OFFSET = 10_000;

/**
 * @typedef {Object} AuditEvent
 * @property {string} dashboardId
 * @property {{ id?: string | null; email: string; role?: string | null } | null} actor
 * @property {string} action
 * @property {string} [resourceType]
 * @property {string} [resourceId]
 * @property {Record<string, unknown>} [details]
 * @property {string | string[] | null} [ip]
 * @property {string | string[] | null} [userAgent]
 */

const insertStmt = db.prepare(`
  INSERT INTO audit_log (
    dashboard_id, actor_user_id, actor_email, actor_role,
    action, resource_type, resource_id, details, ip, user_agent
  ) VALUES (
    @dashboard_id, @actor_user_id, @actor_email, @actor_role,
    @action, @resource_type, @resource_id, @details, @ip, @user_agent
  )
`);

function bigintReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** @param {Record<string, unknown> | undefined} details */
function serialiseDetails(details) {
  if (!details) return null;
  let encoded;
  try {
    encoded = JSON.stringify(details, bigintReplacer);
  } catch (err) {
    return JSON.stringify({ _serialise_failed: true, error: /** @type {Error} */ (err).message });
  }
  if (encoded.length <= MAX_DETAILS_BYTES) return encoded;
  return JSON.stringify(
    { _truncated: true, _original_bytes: encoded.length, preview: encoded.slice(0, 512) },
    bigintReplacer,
  );
}

/** @param {unknown} value @returns {string | null} */
function coerceTextColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }
  try {
    return String(value);
  } catch {
    return null;
  }
}

/** @param {AuditEvent} event */
async function recordAudit(event) {
  if (!event || !event.dashboardId || !event.action) {
    console.error(
      `[audit] DROPPED event with missing required field(s). ` +
        `action=${event?.action ?? '<missing>'} dashboardId=${event?.dashboardId ?? '<missing>'}`,
    );
    return;
  }

  try {
    const role = normalizeRole(event.actor?.role);
    await insertStmt.run({
      dashboard_id: event.dashboardId,
      actor_user_id: event.actor?.id ?? null,
      actor_email: event.actor?.email ?? 'system',
      actor_role: role,
      action: event.action,
      resource_type: event.resourceType ?? null,
      resource_id: event.resourceId ?? null,
      details: serialiseDetails(event.details),
      ip: coerceTextColumn(event.ip),
      user_agent: coerceTextColumn(event.userAgent),
    });
  } catch (err) {
    console.error(
      `[audit] failed to record ${event.action} for ${event.dashboardId}: ${
        /** @type {Error} */ (err).message
      }`,
    );
  }
}

/**
 * @param {any} req
 * @param {string} action
 * @param {{ resourceType?: string; resourceId?: string; details?: Record<string, unknown> }} [opts]
 */
async function recordAuditFromReq(req, action, opts = {}) {
  const dashboardId = req.dashboard?.id;
  if (!dashboardId) return;
  const xff = req.headers?.['x-forwarded-for'];
  const forwarded = Array.isArray(xff) ? xff[0] || null : xff || null;
  const uaHeader = req.headers?.['user-agent'];
  const userAgent = Array.isArray(uaHeader) ? uaHeader[0] || null : uaHeader || null;
  await recordAudit({
    dashboardId,
    actor: req.user ? { id: req.user.id, email: req.user.email, role: req.user.role } : null,
    action,
    resourceType: opts.resourceType,
    resourceId: opts.resourceId,
    details: opts.details,
    ip: req.ip || forwarded,
    userAgent,
  });
}

/**
 * @param {string} dashboardId
 * @param {{ limit?: number; offset?: number; action?: string; actor?: string }} [opts]
 */
async function listAudit(dashboardId, opts = {}) {
  const rawLimit = Number.isFinite(opts.limit) ? /** @type {number} */ (opts.limit) : 100;
  const rawOffset = Number.isFinite(opts.offset) ? /** @type {number} */ (opts.offset) : 0;
  const limit = Math.min(Math.max(1, rawLimit), 500);
  const offset = Math.min(Math.max(0, rawOffset), MAX_LIST_OFFSET);
  const conditions = ['dashboard_id = @dashboard_id'];
  /** @type {Record<string, unknown>} */
  const params = { dashboard_id: dashboardId, limit, offset };
  if (opts.action) {
    conditions.push('action = @action');
    params.action = opts.action;
  }
  if (opts.actor) {
    conditions.push('actor_email = @actor');
    params.actor = opts.actor;
  }
  const rows = /** @type {any[]} */ (
    await db
      .prepare(
        `SELECT id, dashboard_id, actor_user_id, actor_email, actor_role,
                action, resource_type, resource_id, details, ip, user_agent, created_at
         FROM audit_log
         WHERE ${conditions.join(' AND ')}
         ORDER BY id DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(params)
  );
  return rows.map((r) => ({ ...r, details: r.details ? safeParse(r.details) : null }));
}

/** @param {string} s */
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

module.exports = {
  recordAudit,
  recordAuditFromReq,
  listAudit,
  _coerceTextColumn: coerceTextColumn,
};
