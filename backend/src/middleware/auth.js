// @ts-check
// Shared API key authentication middleware for /v1 routes.
// Uses key_prefix for O(1) candidate lookup, then bcrypt for verification.
// Key format: obolus_<48 random hex chars>; key_prefix = chars 9-21 of the key.

const bcrypt = require('bcryptjs');
const db = require('../db');

const KEY_MIN_LENGTH = 21;
const KEY_MAX_LENGTH = 128;
const MAX_AUTH_CANDIDATES = 20;

// One-time startup check: log the count of legacy NULL-prefix rows.
(async () => {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE key_prefix IS NULL`)
      .get();
    const legacyCount = row?.n;
    if (legacyCount > 0) {
      console.warn(
        `[auth] ${legacyCount} legacy api_keys rows have NULL key_prefix — ` +
          `these participate in every auth attempt via the fallback query. ` +
          `Migrate them by setting key_prefix = substr(key, 10, 12) after verifying the raw key, ` +
          `or retire the rows if they're no longer valid.`,
      );
    }
  } catch (_) {
    /* table doesn't exist yet — module load during fresh-install migration */
  }
})();

module.exports = async function auth(req, res, next) {
  const rawKey = req.headers['x-api-key'];
  if (!rawKey) return res.status(401).json({ error: 'missing_api_key' });
  if (typeof rawKey !== 'string') return res.status(401).json({ error: 'invalid_api_key' });
  const key = rawKey;

  if (!key.startsWith('obolus_') || key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  const keyPrefix = key.slice(9, 21);

  const candidates = /** @type {any[]} */ (
    await db
      .prepare(
        `SELECT * FROM api_keys
         WHERE enabled = 1 AND (key_prefix = ? OR key_prefix IS NULL)
         LIMIT ?`,
      )
      .all(keyPrefix, MAX_AUTH_CANDIDATES)
  );

  for (const candidate of candidates) {
    let matched = false;
    try {
      matched = await bcrypt.compare(key, candidate.key_hash);
    } catch (err) {
      console.warn(
        `[auth] bcrypt.compare threw on api_key_id=${candidate.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!matched) continue;

    if (candidate.expires_at) {
      const expiresAtMs = new Date(candidate.expires_at).getTime();
      if (!Number.isFinite(expiresAtMs)) {
        console.error(
          `[auth] api_keys.id=${candidate.id} has unparseable expires_at=${JSON.stringify(
            candidate.expires_at,
          )} — failing closed as expired. Ops: fix the row.`,
        );
        return res
          .status(401)
          .json({ error: 'api_key_expired', message: 'This API key has expired.' });
      }
      if (expiresAtMs < Date.now()) {
        return res
          .status(401)
          .json({ error: 'api_key_expired', message: 'This API key has expired.' });
      }
    }
    if (candidate.suspended) {
      return res.status(401).json({
        error: 'api_key_suspended',
        message: 'This API key has been suspended by the operator.',
      });
    }

    req.apiKey = candidate;
    // Fire-and-forget last_used_at update — cosmetic, must not fail the auth.
    db.prepare(`UPDATE api_keys SET last_used_at = NOW() WHERE id = ?`)
      .run(candidate.id)
      .catch((err) => {
        console.warn(
          `[auth] last_used_at update failed for api_key_id=${candidate.id}: ${
            err instanceof Error ? err.message : String(err)
          } — auth still succeeds`,
        );
      });
    return next();
  }

  return res.status(401).json({ error: 'invalid_api_key' });
};
