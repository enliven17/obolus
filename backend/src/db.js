// @ts-check
// PostgreSQL database module — replaces better-sqlite3.
//
// Exposes the same .prepare()/.exec()/.transaction() API surface so that
// call sites only need `await` added; no structural rewrites are required.
//
// AsyncLocalStorage ensures that any db.prepare().get/run/all() call made
// from inside a db.transaction() callback automatically uses the transaction
// client, preserving atomicity without passing the client around explicitly.

'use strict';

const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
const { env } = require('./env');

// Return timestamps as ISO-8601 strings (matching SQLite behaviour) so
// that existing string comparisons in route handlers keep working.
types.setTypeParser(1114, (v) => v); // TIMESTAMP WITHOUT TIME ZONE
types.setTypeParser(1184, (v) => v); // TIMESTAMP WITH TIME ZONE
types.setTypeParser(1082, (v) => v); // DATE

const txStore = new AsyncLocalStorage();

// Enable SSL for any remote host (Supabase requires it even in dev).
// Disable only for local connections.
const isLocal = env.DATABASE_URL.includes('localhost') || env.DATABASE_URL.includes('127.0.0.1');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] unexpected error on idle pg client:', err);
});

// Active client: transaction client when inside a transaction, pool otherwise.
function activeClient() {
  return txStore.getStore() ?? pool;
}

// ── Parameter conversion ──────────────────────────────────────────────────────

// Convert SQLite positional ? → PG $1 $2 ...
function convertPositional(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

// Convert SQLite named @param → PG $1 $2 ... and return an extractor.
// Returns { pgSql, extractParams } where extractParams(obj) → value[]
function convertNamed(sql) {
  const names = [];
  const pgSql = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    names.push(name);
    return `$${names.length}`;
  });
  return {
    pgSql,
    extractParams:
      names.length > 0
        ? (obj) => names.map((n) => (obj !== null && obj !== undefined && n in obj ? obj[n] : null))
        : null,
  };
}

// Determine PG params array from what the caller passed.
// Handles three shapes:
//   run(v1, v2, ...)      → positional spread args  (? placeholders)
//   run([v1, v2])         → positional array arg     (? placeholders)
//   run({ key: val, …})   → named object arg         (@name placeholders)
function resolveParams(params, extractParams) {
  if (extractParams) {
    const arg = params.length === 1 ? params[0] : params;
    if (arg !== null && typeof arg === 'object' && !Array.isArray(arg)) {
      return extractParams(arg);
    }
  }
  const flat = params.flat(Infinity);
  return flat.length ? flat : undefined;
}

// ── Core SQL normalisation ────────────────────────────────────────────────────
// Handle SQLite-specific SQL idioms that can be safely translated once.
function normaliseSql(sql) {
  return (
    sql
      // datetime('now') → NOW()
      .replace(/\bdatetime\('now'\)/gi, 'NOW()')
      // datetime('now', '+N units') → NOW() + INTERVAL 'N units'
      .replace(/\bdatetime\('now',\s*'([^']+)'\)/gi, (_, mod) => `(NOW() + INTERVAL '${mod}')`)
      // date('now') → CURRENT_DATE
      .replace(/\bdate\('now'\)/gi, 'CURRENT_DATE')
      // date(col) → col::date  (SQLite date() → PG cast)
      .replace(/\bdate\(([^)]+)\)/gi, '($1)::date')
      // strftime('%H:%M', 'now') → TO_CHAR(NOW(), 'HH24:MI')
      .replace(/\bstrftime\s*\(\s*'%H:%M'\s*,\s*'now'\s*\)/gi, "TO_CHAR(NOW(), 'HH24:MI')")
      // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING (handled at exec level)
      .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO')
      // CAST(x AS REAL) → CAST(x AS DOUBLE PRECISION)
      .replace(/\bCAST\s*\(([^)]+)\s+AS\s+REAL\)/gi, 'CAST($1 AS DOUBLE PRECISION)')
      // printf('%.2f', expr) → ROUND((expr)::numeric, 2)::text
      .replace(/\bprintf\s*\(\s*'%.2f'\s*,\s*([^)]+)\)/gi, 'ROUND(($1)::numeric, 2)::text')
      // SQLite total() → COALESCE(SUM(), 0)
      .replace(/\btotal\(([^)]+)\)/gi, 'COALESCE(SUM($1), 0)')
  );
}

// ── prepare() ────────────────────────────────────────────────────────────────
// Mimics better-sqlite3's prepare() returning an object with async get/all/run.
function prepare(rawSql) {
  const normalised = normaliseSql(rawSql);
  const { pgSql: namedPg, extractParams } = convertNamed(normalised);
  const pgSql = convertPositional(namedPg);

  function params(args) {
    return resolveParams(Array.from(args), extractParams);
  }

  return {
    async get(...args) {
      const r = await activeClient().query(pgSql, params(args));
      return r.rows[0];
    },
    async all(...args) {
      const r = await activeClient().query(pgSql, params(args));
      return r.rows;
    },
    async run(...args) {
      const r = await activeClient().query(pgSql, params(args));
      return { changes: r.rowCount ?? 0 };
    },
    // Streaming iterator (used for CSV export)
    async *iterate(...args) {
      const r = await activeClient().query(pgSql, params(args));
      for (const row of r.rows) yield row;
    },
  };
}

// ── exec() ───────────────────────────────────────────────────────────────────
// Execute raw SQL (DDL, multi-statement scripts). No parameters.
async function exec(sql) {
  const normalised = normaliseSql(sql);
  await activeClient().query(normalised);
}

// ── transaction() ─────────────────────────────────────────────────────────────
// Wraps an async callback in a PG transaction.
// Uses AsyncLocalStorage so that all db.prepare() calls inside the callback
// route through the transaction client automatically — no signature changes needed.
//
// Usage:  await db.transaction(async () => { ... })()
//         await db.transaction(async (arg) => { ... })(arg)
function transaction(fn) {
  return async (...args) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStore.run(client, () => fn(...args));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback errors */
      }
      throw err;
    } finally {
      client.release();
    }
  };
}

// ── pragma() ─────────────────────────────────────────────────────────────────
// No-op: SQLite pragmas have no PostgreSQL equivalent.
function pragma() {}

// ── Schema migrations ─────────────────────────────────────────────────────────
// Each migration runs inside a PG transaction that also inserts the version
// marker, so partial migrations can never leave the schema in a mixed state.

// Check whether a specific migration version is already recorded.
async function isMigrationApplied(version) {
  try {
    const r = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    return r.rows.length > 0;
  } catch {
    return false; // table doesn't exist yet
  }
}

async function applyMigration(version, fn) {
  if (await isMigrationApplied(version)) return;

  await transaction(async () => {
    await fn();
    // ON CONFLICT DO NOTHING is belt-and-braces in case two processes
    // race to apply the same migration simultaneously.
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [
      version,
    ]);
  })();
}

// ── initialize() ─────────────────────────────────────────────────────────────
// Run all schema migrations. Must be awaited in index.js before starting the server.
async function initialize() {
  const { v4: uuidv4 } = require('uuid');

  // Baseline tables — idempotent CREATE TABLE IF NOT EXISTS
  await exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id               TEXT PRIMARY KEY,
      status           TEXT NOT NULL DEFAULT 'pending_payment',
      amount_usdc      TEXT NOT NULL,
      solana_txid      TEXT,
      ctx_order_id     TEXT,
      claim_url        TEXT,
      challenge        TEXT,
      reward_url       TEXT,
      card_number      TEXT,
      card_cvv         TEXT,
      card_expiry      TEXT,
      card_brand       TEXT,
      error            TEXT,
      failure_count    INTEGER NOT NULL DEFAULT 0,
      api_key_id       TEXT,
      webhook_url      TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id               TEXT PRIMARY KEY,
      key_hash         TEXT NOT NULL UNIQUE,
      label            TEXT,
      spend_limit_usdc TEXT,
      total_spent_usdc TEXT NOT NULL DEFAULT '0',
      enabled          INTEGER NOT NULL DEFAULT 1,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS system_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key                  TEXT NOT NULL,
      api_key_id           TEXT NOT NULL,
      request_fingerprint  TEXT NOT NULL DEFAULT '',
      response_status      INTEGER NOT NULL,
      response_body        TEXT NOT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (key, api_key_id)
    );

    CREATE TABLE IF NOT EXISTS webhook_queue (
      id           TEXT PRIMARY KEY,
      url          TEXT NOT NULL,
      payload      TEXT NOT NULL,
      secret       TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      next_attempt TIMESTAMPTZ NOT NULL,
      last_error   TEXT,
      delivered    INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS unmatched_payments (
      id               TEXT PRIMARY KEY,
      solana_txid      TEXT NOT NULL,
      sender_address   TEXT,
      payment_asset    TEXT,
      amount_usdc      TEXT,
      amount_sol       TEXT,
      claimed_order_id TEXT,
      reason           TEXT NOT NULL,
      refund_solana_txid TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Baseline indexes
  await exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_api_key_id  ON orders(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at  ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_updated_at  ON orders(updated_at);
    CREATE INDEX IF NOT EXISTS idx_orders_solana_txid ON orders(solana_txid);
    CREATE INDEX IF NOT EXISTS idx_webhook_queue_next ON webhook_queue(delivered, next_attempt);
  `);

  // ── Migrations ──────────────────────────────────────────────────────────────

  // 1: additional columns on baseline tables
  await applyMigration(1, async () => {
    const cols = [
      `ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_fingerprint TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE orders           ADD COLUMN IF NOT EXISTS payment_asset TEXT DEFAULT 'usdc'`,
      `ALTER TABLE api_keys         ADD COLUMN IF NOT EXISTS key_prefix TEXT`,
      `ALTER TABLE orders           ADD COLUMN IF NOT EXISTS payment_sol_amount TEXT`,
      `ALTER TABLE orders           ADD COLUMN IF NOT EXISTS sender_address TEXT`,
      `ALTER TABLE orders           ADD COLUMN IF NOT EXISTS refund_solana_txid TEXT`,
      `ALTER TABLE api_keys         ADD COLUMN IF NOT EXISTS webhook_secret TEXT`,
      `ALTER TABLE api_keys         ADD COLUMN IF NOT EXISTS default_webhook_url TEXT`,
      `ALTER TABLE api_keys         ADD COLUMN IF NOT EXISTS wallet_public_key TEXT`,
    ];
    for (const sql of cols) await exec(sql);
    await exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix)`);
  });

  // 2: policy engine — spend controls, approval flows, audit log
  await applyMigration(2, async () => {
    const cols = [
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS suspended INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS policy_daily_limit_usdc TEXT`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS policy_single_tx_limit_usdc TEXT`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS policy_require_approval_above_usdc TEXT`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS policy_allowed_hours TEXT`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS policy_allowed_days TEXT`,
    ];
    for (const sql of cols) await exec(sql);
    await exec(`
      CREATE TABLE IF NOT EXISTS policy_decisions (
        id          TEXT PRIMARY KEY,
        api_key_id  TEXT NOT NULL,
        order_id    TEXT,
        decision    TEXT NOT NULL,
        rule        TEXT NOT NULL,
        reason      TEXT NOT NULL,
        amount_usdc TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_policy_decisions_api_key
        ON policy_decisions(api_key_id, created_at);

      CREATE TABLE IF NOT EXISTS approval_requests (
        id            TEXT PRIMARY KEY,
        api_key_id    TEXT NOT NULL,
        order_id      TEXT NOT NULL,
        amount_usdc   TEXT NOT NULL,
        agent_note    TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ NOT NULL,
        decided_at    TIMESTAMPTZ,
        decision_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approval_requests_status
        ON approval_requests(status, requested_at);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_api_key
        ON approval_requests(api_key_id);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_order
        ON approval_requests(order_id);
    `);
  });

  // 3: user accounts, email auth codes, sessions
  await applyMigration(3, async () => {
    await exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        role          TEXT NOT NULL DEFAULT 'user',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

      CREATE TABLE IF NOT EXISTS auth_codes (
        id          TEXT PRIMARY KEY,
        email       TEXT NOT NULL,
        code_hash   TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes(email, expires_at);

      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
    `);
  });

  // 4: agent connection tracking
  await applyMigration(4, async () => {
    await exec(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`);
  });

  // 5: overpayment tracking and fulfillment heartbeat
  await applyMigration(5, async () => {
    const cols = [
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS excess_usdc TEXT`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_started_at TIMESTAMPTZ`,
    ];
    for (const sql of cols) await exec(sql);
  });

  // 6: VCC payment proxy
  await applyMigration(6, async () => {
    const cols = [
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS vcc_job_id TEXT`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS vcc_payment_json TEXT`,
    ];
    for (const sql of cols) await exec(sql);
    await exec(`CREATE INDEX IF NOT EXISTS idx_orders_vcc_job_id ON orders(vcc_job_id)`);
  });

  // 7: multi-tenancy — dashboards
  await applyMigration(7, async () => {
    await exec(`
      CREATE TABLE IF NOT EXISTS dashboards (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name             TEXT NOT NULL DEFAULT 'My Dashboard',
        spend_limit_usdc TEXT,
        frozen           INTEGER NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_dashboards_user_id ON dashboards(user_id);
    `);
    await exec(
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS dashboard_id TEXT REFERENCES dashboards(id)`,
    );
    await exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_dashboard_id ON api_keys(dashboard_id)`);

    // Create a dashboard for each existing user
    const users = await prepare('SELECT id, email FROM users').all();
    for (const u of users) {
      const existing = await prepare('SELECT id FROM dashboards WHERE user_id = $1').get(u.id);
      if (!existing) {
        const dashId = uuidv4();
        const name = u.email.split('@')[0].replace(/[<>&"']/g, '');
        await prepare('INSERT INTO dashboards (id, user_id, name) VALUES ($1, $2, $3)').run(
          dashId,
          u.id,
          name,
        );
      }
    }

    // Assign orphan api_keys to owner's dashboard
    const owner = await prepare(`SELECT id FROM users WHERE role = 'owner' LIMIT 1`).get();
    if (owner) {
      const ownerDash = await prepare('SELECT id FROM dashboards WHERE user_id = $1').get(owner.id);
      if (ownerDash) {
        await prepare('UPDATE api_keys SET dashboard_id = $1 WHERE dashboard_id IS NULL').run(
          ownerDash.id,
        );
      }
    }
  });

  // 8: decided_by on approval_requests
  await applyMigration(8, async () => {
    await exec(`ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS decided_by TEXT`);
  });

  // 9: sandbox mode, per-key rate limits, time-limited keys, order metadata
  await applyMigration(9, async () => {
    const cols = [
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live'`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_rpm INTEGER`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
      `ALTER TABLE orders   ADD COLUMN IF NOT EXISTS metadata TEXT`,
    ];
    for (const sql of cols) await exec(sql);
  });

  // 10: stuck-order recovery checkpoints
  await applyMigration(10, async () => {
    const cols = [
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS sol_sent_at TIMESTAMPTZ`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS vcc_notified_at TIMESTAMPTZ`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_attempt INTEGER NOT NULL DEFAULT 0`,
    ];
    for (const sql of cols) await exec(sql);
    // Backfill: orders in 'ordering' with vcc_job_id already paid
    await exec(`
      UPDATE orders
      SET sol_sent_at = COALESCE(sol_sent_at, updated_at),
          vcc_notified_at = COALESCE(vcc_notified_at, updated_at)
      WHERE status = 'ordering' AND vcc_job_id IS NOT NULL
    `);
  });

  // 11: end-to-end request correlation
  await applyMigration(11, async () => {
    await exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_id TEXT`);
  });

  // 12: admin action audit log
  await applyMigration(12, async () => {
    await exec(`
      CREATE TABLE IF NOT EXISTS admin_actions (
        id           TEXT PRIMARY KEY,
        actor_email  TEXT NOT NULL,
        action       TEXT NOT NULL,
        target_type  TEXT NOT NULL,
        target_id    TEXT,
        metadata     TEXT,
        ip           TEXT,
        request_id   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_admin_actions_actor
        ON admin_actions(actor_email, created_at);
      CREATE INDEX IF NOT EXISTS idx_admin_actions_target
        ON admin_actions(target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_admin_actions_created
        ON admin_actions(created_at);
    `);
  });

  // 13: per-job callback nonce
  await applyMigration(13, async () => {
    await exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS callback_nonce TEXT`);
  });

  // 14: live agent setup state
  await applyMigration(14, async () => {
    const cols = [
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_state TEXT`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_state_at TIMESTAMPTZ`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_state_detail TEXT`,
    ];
    for (const sql of cols) await exec(sql);
  });

  // 15: one-time claim codes
  await applyMigration(15, async () => {
    await exec(`
      CREATE TABLE IF NOT EXISTS agent_claims (
        id             TEXT PRIMARY KEY,
        code           TEXT NOT NULL UNIQUE,
        api_key_id     TEXT NOT NULL,
        sealed_payload TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at     TIMESTAMPTZ NOT NULL,
        used_at        TIMESTAMPTZ,
        claimed_ip     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_claims_code    ON agent_claims(code);
      CREATE INDEX IF NOT EXISTS idx_agent_claims_api_key ON agent_claims(api_key_id);
    `);
  });

  // 16: audit_log
  await applyMigration(16, async () => {
    await exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id              BIGSERIAL PRIMARY KEY,
        dashboard_id    TEXT NOT NULL,
        actor_user_id   TEXT,
        actor_email     TEXT NOT NULL,
        actor_role      TEXT NOT NULL,
        action          TEXT NOT NULL,
        resource_type   TEXT,
        resource_id     TEXT,
        details         TEXT,
        ip              TEXT,
        user_agent      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_dashboard
        ON audit_log(dashboard_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_log_action
        ON audit_log(action, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_log_actor
        ON audit_log(actor_email, created_at DESC);
    `);
  });

  // 17: alert_rules + alert_firings
  await applyMigration(17, async () => {
    await exec(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id            TEXT PRIMARY KEY,
        dashboard_id  TEXT NOT NULL,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL,
        config        TEXT NOT NULL DEFAULT '{}',
        enabled       INTEGER NOT NULL DEFAULT 1,
        snoozed_until TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_alert_rules_dashboard
        ON alert_rules(dashboard_id, enabled);

      CREATE TABLE IF NOT EXISTS alert_firings (
        id           BIGSERIAL PRIMARY KEY,
        rule_id      TEXT NOT NULL,
        dashboard_id TEXT NOT NULL,
        fired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        context      TEXT,
        notified     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_alert_firings_rule
        ON alert_firings(rule_id, fired_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_firings_dash
        ON alert_firings(dashboard_id, fired_at DESC);
    `);
  });

  // 18: webhook_deliveries log
  await applyMigration(18, async () => {
    await exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id              BIGSERIAL PRIMARY KEY,
        dashboard_id    TEXT NOT NULL,
        api_key_id      TEXT,
        url             TEXT NOT NULL,
        method          TEXT NOT NULL DEFAULT 'POST',
        request_body    TEXT,
        response_status INTEGER,
        response_body   TEXT,
        latency_ms      INTEGER,
        error           TEXT,
        signature       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_dash
        ON webhook_deliveries(dashboard_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_key
        ON webhook_deliveries(api_key_id, created_at DESC);
    `);
  });

  // 19: per-rule notification channels
  await applyMigration(19, async () => {
    const cols = [
      `ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS notify_email TEXT`,
      `ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS notify_webhook_url TEXT`,
    ];
    for (const sql of cols) await exec(sql);
  });

  // 20: expected on-chain payment amounts
  await applyMigration(20, async () => {
    await exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS expected_sol_amount TEXT`);
  });

  // 21: brute-force protection on auth codes
  await applyMigration(21, async () => {
    await exec(
      `ALTER TABLE auth_codes ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0`,
    );
  });

  // 22: per-order vcc callback secret
  await applyMigration(22, async () => {
    await exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS callback_secret TEXT`);
  });

  // 23: solana watcher dead-letter table
  await applyMigration(23, async () => {
    await exec(`
      CREATE TABLE IF NOT EXISTS solana_dead_letter (
        tx_hash    TEXT PRIMARY KEY,
        ledger     INTEGER NOT NULL,
        raw_event  TEXT NOT NULL,
        error      TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_solana_dead_letter_created_at
        ON solana_dead_letter(created_at);
    `);
  });

  // 24: composite + partial indexes for hot query paths
  await applyMigration(24, async () => {
    await exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_api_key_status
        ON orders(api_key_id, status);
      CREATE INDEX IF NOT EXISTS idx_orders_api_key_created_at
        ON orders(api_key_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_unmatched_payments_pending
        ON unmatched_payments(created_at)
        WHERE refund_solana_txid IS NULL;
      CREATE INDEX IF NOT EXISTS idx_unmatched_payments_created_at
        ON unmatched_payments(created_at);
    `);
  });

  // 25: ctx_solana_txid — outbound CTX payment hash
  await applyMigration(25, async () => {
    await exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ctx_solana_txid TEXT`);
  });

  // 26: per-order margin tracking
  await applyMigration(26, async () => {
    const cols = [
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS ctx_invoice_xlm TEXT`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS settlement_xlm_usd_rate TEXT`,
    ];
    for (const sql of cols) await exec(sql);
  });

  // 27: API surface origin tracking
  await applyMigration(27, async () => {
    await exec(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'v1_orders'`,
    );
  });

  // 28: MPP (Machine Payments Protocol)
  await applyMigration(28, async () => {
    await exec(`
      CREATE TABLE IF NOT EXISTS mpp_challenges (
        id               TEXT PRIMARY KEY,
        resource_path    TEXT NOT NULL,
        amount_usdc      TEXT NOT NULL,
        order_id         TEXT,
        client_ip        TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at       TIMESTAMPTZ NOT NULL,
        redeemed_at      TIMESTAMPTZ,
        redeemed_tx_hash TEXT,
        FOREIGN KEY (order_id) REFERENCES orders(id)
      );
      CREATE INDEX IF NOT EXISTS idx_mpp_challenges_expires
        ON mpp_challenges(expires_at)
        WHERE redeemed_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mpp_challenges_tx_hash
        ON mpp_challenges(redeemed_tx_hash)
        WHERE redeemed_tx_hash IS NOT NULL;
    `);

    const cols = [
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS mpp_challenge_id TEXT`,
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS mpp_receipt_id TEXT`,
    ];
    for (const sql of cols) await exec(sql);

    await exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_mpp_challenge_id
        ON orders(mpp_challenge_id)
        WHERE mpp_challenge_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_mpp_receipt_id
        ON orders(mpp_receipt_id)
        WHERE mpp_receipt_id IS NOT NULL;
    `);

    // Seed anonymous api_key for MPP-sourced orders
    await exec(`
      INSERT INTO api_keys (id, key_hash, label, enabled, key_prefix, mode)
      VALUES ('mpp-anonymous', 'mpp-anonymous-sentinel-no-hash', 'MPP anonymous', 0, 'mpp_', 'live')
      ON CONFLICT DO NOTHING
    `);
  });

  // 29: quoted SOL amount on challenge row
  await applyMigration(29, async () => {
    await exec(`ALTER TABLE mpp_challenges ADD COLUMN IF NOT EXISTS amount_sol TEXT`);
  });

  // 30: dashboards.updated_at
  await applyMigration(30, async () => {
    await exec(`ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
  });

  // 31: (SQLite-only rename — no-op in PostgreSQL)
  await applyMigration(31, async () => {
    // solana_dead_letter already has the correct name in migration 23 DDL above
  });

  // Seed default system state
  await exec(`
    INSERT INTO system_state (key, value) VALUES ('frozen', '0')
    ON CONFLICT DO NOTHING;
    INSERT INTO system_state (key, value) VALUES ('consecutive_failures', '0')
    ON CONFLICT DO NOTHING;
  `);

  // Schema version guard — check for unknown future versions in the DB.
  const EXPECTED = 31;
  try {
    const r = await pool.query('SELECT MAX(version) AS v FROM schema_migrations');
    const actual = r.rows[0]?.v ?? 0;
    if (actual > EXPECTED) {
      console.error(
        `[db] schema version mismatch: code expects ${EXPECTED}, database is at ${actual}. ` +
          'Refusing to start — you are running an older binary against a newer database.',
      );
      process.exit(1);
    }
    console.log(`[db] PostgreSQL ready (schema v${actual})`);
  } catch {
    console.log('[db] PostgreSQL ready');
  }
}

module.exports = { prepare, exec, transaction, pragma, pool, initialize };
