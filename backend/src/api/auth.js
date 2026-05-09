// @ts-check
// Auth routes — email login code flow + Privy OAuth.

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const { sendLoginCode } = require('../lib/email');
const { isPlatformOwner } = require('../lib/platform');
const { recordAudit } = require('../lib/audit');

const router = Router();

const CODE_TTL_MINUTES = 15;
const CODE_MAX_PER_WINDOW = 3;
const SESSION_TTL_DAYS = 7;
const VERIFY_FAILED_ATTEMPT_LIMIT = 5;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (/** @type {any} */ req) => ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) =>
    res.status(429).json({
      error: 'too_many_requests',
      message: 'Too many login requests from this IP. Try again in a few minutes.',
    }),
});

const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  keyGenerator: (/** @type {any} */ req) => ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) =>
    res.status(429).json({
      error: 'too_many_attempts',
      message: 'Too many verification attempts from this IP. Try again in a few minutes.',
    }),
});

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}
function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function clientIp(req) {
  if (req.ip) return String(req.ip);
  const xff = req.headers?.['x-forwarded-for'];
  if (!xff) return null;
  if (Array.isArray(xff)) return xff.length > 0 ? String(xff[0]) : null;
  return String(xff).split(',')[0]?.trim() || null;
}

function clientUserAgent(req) {
  const ua = req.headers?.['user-agent'];
  if (!ua) return null;
  if (Array.isArray(ua)) return ua.length > 0 ? String(ua[0]) : null;
  return String(ua);
}

function extractBearerToken(req) {
  let raw = req.headers?.authorization;
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== 'string') return null;
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  return token.length > 0 ? token : null;
}

// ── POST /auth/login ──────────────────────────────────────────────────────────

router.post('/login', loginLimiter, async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res
      .status(400)
      .json({ error: 'invalid_request', message: 'Request body must be a JSON object.' });
  }
  const { email } = req.body;
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res
      .status(400)
      .json({ error: 'invalid_email', message: 'A valid email address is required.' });
  }
  const addr = normalizeEmail(email);

  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (ownerEmail) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
    if (/** @type {any} */ (row).n === 0 && addr !== ownerEmail) return res.json({ ok: true });
  }

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM auth_codes WHERE email = ? AND used_at IS NULL AND expires_at > NOW()`,
    )
    .get(addr);
  if (/** @type {any} */ (countRow).n >= CODE_MAX_PER_WINDOW) {
    return res.status(429).json({
      error: 'too_many_requests',
      message: 'Too many login attempts. Wait a few minutes and try again.',
    });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

  await db
    .prepare(`INSERT INTO auth_codes (id, email, code_hash, expires_at) VALUES (?, ?, ?, ?)`)
    .run(uuidv4(), addr, hashToken(code), expiresAt);

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[auth] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`[auth] LOGIN CODE for ${addr}: ${code}`);
    console.log(`[auth] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  }

  try {
    await sendLoginCode(addr, code);
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[auth] email send failed:', err.message);
      return res.status(500).json({
        error: 'email_failed',
        message: 'Failed to send login code. Check SMTP configuration.',
      });
    }
    console.warn(`[auth] email skipped (${err.message}) — use the logged code above`);
  }

  res.json({ ok: true });
});

// ── POST /auth/verify ────────────────────────────────────────────────────────

router.post('/verify', verifyLimiter, async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res
      .status(400)
      .json({ error: 'invalid_request', message: 'Request body must be a JSON object.' });
  }
  const { email, code } = req.body;
  if (!email || !code || typeof email !== 'string' || typeof code !== 'string') {
    return res
      .status(400)
      .json({ error: 'missing_fields', message: 'email and code are required strings.' });
  }

  const addr = normalizeEmail(email);
  const codeHash = hashToken(code.trim());
  const now = new Date().toISOString();

  const used = await db
    .prepare(
      `UPDATE auth_codes SET used_at = ? WHERE email = ? AND code_hash = ? AND used_at IS NULL AND expires_at > NOW()`,
    )
    .run(now, addr, codeHash);

  if (used.changes === 0) {
    await db
      .prepare(
        `UPDATE auth_codes SET failed_attempts = failed_attempts + 1 WHERE email = ? AND used_at IS NULL AND expires_at > NOW()`,
      )
      .run(addr);
    const maxRow = await db
      .prepare(
        `SELECT MAX(failed_attempts) AS m FROM auth_codes WHERE email = ? AND used_at IS NULL AND expires_at > NOW()`,
      )
      .get(addr);
    const maxFails = /** @type {any} */ (maxRow).m;
    if (maxFails !== null && maxFails >= VERIFY_FAILED_ATTEMPT_LIMIT) {
      await db
        .prepare(`UPDATE auth_codes SET used_at = ? WHERE email = ? AND used_at IS NULL`)
        .run(now, addr);
      return res.status(429).json({
        error: 'too_many_attempts',
        message: 'Too many incorrect codes for this email. Request a new login code and try again.',
      });
    }
    return res.status(401).json({ error: 'invalid_code', message: 'Invalid or expired code.' });
  }

  const userBootstrap = db.transaction(async (nowIso) => {
    let u = /** @type {any} */ (await db.prepare(`SELECT * FROM users WHERE email = ?`).get(addr));
    if (!u) {
      const countRow = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
      const isFirst = /** @type {any} */ (countRow).n === 0;
      const id = uuidv4();
      await db
        .prepare(`INSERT INTO users (id, email, role) VALUES (?, ?, ?)`)
        .run(id, addr, isFirst ? 'owner' : 'user');
      u = /** @type {any} */ (await db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
    }
    await db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(nowIso, u.id);
    let d = /** @type {any} */ (
      await db.prepare(`SELECT id, name FROM dashboards WHERE user_id = ?`).get(u.id)
    );
    if (!d) {
      const dashId = uuidv4();
      const name = addr.split('@')[0];
      await db
        .prepare(`INSERT INTO dashboards (id, user_id, name) VALUES (?, ?, ?)`)
        .run(dashId, u.id, name);
      d = { id: dashId, name };
    }
    return { user: u, dashboard: d };
  });
  const { user, dashboard } = await userBootstrap(now);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const sessionExpiresAt = new Date(
    Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  await db
    .prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
    .run(uuidv4(), user.id, hashToken(rawToken), sessionExpiresAt);

  await recordAudit({
    dashboardId: dashboard.id,
    actor: { id: user.id, email: user.email, role: user.role },
    action: 'auth.session_created',
    resourceType: 'session',
    resourceId: user.id,
    details: {
      first_login: !user.last_login_at,
      role: user.role,
      is_platform_owner: isPlatformOwner(user.email),
    },
    ip: clientIp(req),
    userAgent: clientUserAgent(req),
  });

  res.json({
    token: rawToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      is_platform_owner: isPlatformOwner(user.email),
    },
    dashboard: { id: dashboard.id, name: dashboard.name },
  });
});

// ── POST /auth/privy ─────────────────────────────────────────────────────────

const privyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (/** @type {any} */ req) => ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) => res.status(429).json({ error: 'too_many_requests' }),
});

router.post('/privy', privyLimiter, async (req, res) => {
  const { accessToken, email } = req.body || {};
  if (!accessToken || !email || typeof email !== 'string') {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const addr = normalizeEmail(email);

  const privyAppId = process.env.PRIVY_APP_ID;
  const privyAppSecret = process.env.PRIVY_APP_SECRET;

  if (privyAppId) {
    try {
      const headers = /** @type {Record<string,string>} */ ({
        Authorization: `Bearer ${accessToken}`,
        'privy-app-id': privyAppId,
      });
      if (privyAppSecret) {
        const credentials = Buffer.from(`${privyAppId}:${privyAppSecret}`).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
        headers['privy-access-token'] = accessToken;
      }
      const verify = await fetch('https://auth.privy.io/api/v1/users/me', {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!verify.ok) {
        console.warn(`[auth/privy] token verify failed: HTTP ${verify.status} for ${addr}`);
        return res.status(401).json({ error: 'invalid_privy_token' });
      }
      const privyUser = await verify.json();
      const linkedEmail =
        privyUser?.email?.address ||
        privyUser?.linked_accounts?.find((/** @type {any} */ a) => a.type === 'email')?.address;
      if (linkedEmail && normalizeEmail(linkedEmail) !== addr) {
        console.warn(`[auth/privy] email mismatch: claimed=${addr}, privy=${linkedEmail}`);
        return res.status(401).json({ error: 'email_mismatch' });
      }
      console.log(`[auth/privy] token verified for ${addr}`);
    } catch (err) {
      console.error('[auth/privy] verify failed:', err.message);
      return res.status(502).json({ error: 'privy_verify_failed' });
    }
  } else {
    return res
      .status(503)
      .json({ error: 'privy_not_configured', message: 'Set PRIVY_APP_ID in backend .env' });
  }

  const now = new Date().toISOString();
  const userBootstrap = db.transaction(async (emailArg) => {
    let u = /** @type {any} */ (
      await db.prepare(`SELECT * FROM users WHERE email = ?`).get(emailArg)
    );
    if (!u) {
      const uid = uuidv4();
      const countRow = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
      const isFirst = /** @type {any} */ (countRow).n === 0;
      await db
        .prepare(`INSERT INTO users (id, email, role, last_login_at) VALUES (?, ?, ?, ?)`)
        .run(uid, emailArg, isFirst ? 'owner' : 'user', now);
      u = /** @type {any} */ (await db.prepare(`SELECT * FROM users WHERE id = ?`).get(uid));
    } else {
      await db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(now, u.id);
    }
    let d = /** @type {any} */ (
      await db.prepare(`SELECT * FROM dashboards WHERE user_id = ?`).get(u.id)
    );
    if (!d) {
      const dashId = uuidv4();
      const name = emailArg.split('@')[0].replace(/[<>&"']/g, '');
      await db
        .prepare(`INSERT INTO dashboards (id, user_id, name) VALUES (?, ?, ?)`)
        .run(dashId, u.id, name);
      d = { id: dashId, name };
    }
    return { user: u, dashboard: d };
  });
  const { user, dashboard } = await userBootstrap(addr);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const sessionExpiresAt = new Date(
    Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  await db
    .prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
    .run(uuidv4(), user.id, hashToken(rawToken), sessionExpiresAt);

  console.log(`[auth/privy] session created for ${addr} (role=${user.role})`);
  res.json({
    token: rawToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      is_platform_owner: isPlatformOwner(user.email),
    },
    dashboard: { id: dashboard.id, name: dashboard.name },
  });
});

// ── POST /auth/logout ────────────────────────────────────────────────────────

router.post('/logout', async (req, res) => {
  const token = extractBearerToken(req);
  if (token) {
    const row = /** @type {any} */ (
      await db
        .prepare(
          `SELECT u.id AS user_id, u.email, u.role, d.id AS dashboard_id
                  FROM sessions s
                  JOIN users u ON s.user_id = u.id
                  LEFT JOIN dashboards d ON d.user_id = u.id
                  WHERE s.token_hash = ?`,
        )
        .get(hashToken(token))
    );
    await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
    if (row && row.dashboard_id) {
      await recordAudit({
        dashboardId: row.dashboard_id,
        actor: { id: row.user_id, email: row.email, role: row.role },
        action: 'auth.session_deleted',
        resourceType: 'session',
        resourceId: row.user_id,
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
      });
    }
  }
  res.json({ ok: true });
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────

router.get('/me', async (req, res) => {
  const token = extractBearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const row = /** @type {any} */ (
    await db
      .prepare(
        `SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > NOW()`,
      )
      .get(hashToken(token))
  );

  if (!row) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: { ...row, is_platform_owner: isPlatformOwner(row.email) } });
});

module.exports = router;
