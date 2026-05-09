// @ts-check
// requireAuth middleware — validates session token from Authorization: Bearer header.
// Attaches req.user = { id, email, role, is_platform_owner } on success.

const crypto = require('crypto');
const db = require('../db');
const { isPlatformOwner } = require('../lib/platform');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * @param {unknown} header
 * @returns {string | null}
 */
function coerceAuthHeader(header) {
  if (typeof header === 'string') return header;
  if (Array.isArray(header) && typeof header[0] === 'string') return header[0];
  return null;
}

async function requireAuth(req, res, next) {
  const rawAuth = coerceAuthHeader(req.headers?.authorization);
  if (!rawAuth) return res.status(401).json({ error: 'unauthorized' });

  const token = rawAuth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const row = /** @type {any} */ (
    await db
      .prepare(
        `
      SELECT u.id, u.email, u.role
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ?
        AND s.expires_at > NOW()
    `,
      )
      .get(hashToken(token))
  );

  if (!row) return res.status(401).json({ error: 'unauthorized' });

  req.user = { ...row, is_platform_owner: isPlatformOwner(row.email) };
  next();
}

module.exports = requireAuth;
