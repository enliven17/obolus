// Unit tests for backend/src/env.js (adversarial audit 2026-04-16).
//
// env.js calls process.exit(1) at module load on validation failure,
// so we can't unit-test it by mutating process.env and re-requiring.
// Instead the schema itself is exported as `_EnvSchema` and this file
// exercises it via `safeParse` directly. Covers:
//
//   F1-env: Solana strkey shape validation (56 chars, first char = type
//           prefix, remaining 55 chars are base58). Pre-fix a typo like
//           'S' or 'Cwrong' passed boot and crashed at first use with
//           a cryptic SDK decode error.
//
//   F2-env: INTERNAL_EMAILS per-entry email shape validation. Pre-fix
//           a typo silently excluded an operator from /internal/* with
//           no boot-time signal.
//
//   F3-env: CORS_ORIGINS per-entry URL origin validation. Pre-fix a
//           typo silently blocked dashboard browser traffic.
//
//   F4-env: URL scheme constraint (http / https only). Pre-fix,
//           ftp:// / file:// / javascript: all passed zod's .url().

require('../helpers/env'); // minimal valid env so schema defaults are set

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// src/env.js runs safeParse(process.env) at module load and
// process.exit(1) on failure. The test harness's OBOLUS_BASE_URL is
// `https://api.obolus.test`, which is legitimate under the F5-env
// reserved-TLD fix — but we still require src/env AFTER the helper so
// the schema itself can be pulled out cleanly.
const { _EnvSchema } = require('../../src/env');

// Build a minimal valid env object by snapshotting the test harness.
// Tests mutate specific fields and re-validate to isolate each finding.
function baseEnv() {
  return {
    NODE_ENV: 'test',
    PORT: '4000',
    DB_PATH: ':memory:',
    SOLANA_NETWORK: 'testnet',
    SOLANA_TREASURY_SECRET: 'S' + 'A'.repeat(55),
    SOLANA_USDC_MINT: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    SOLANA_PROGRAM_ID: 'C' + 'A'.repeat(55),
    VCC_API_BASE: 'https://localhost:5000',
    OBOLUS_BASE_URL: 'https://api.obolus.test',
    VCC_CALLBACK_SECRET: 'x'.repeat(32),
  };
}

function issueFor(result, fieldName) {
  if (result.success) return null;
  return result.error.issues.find((i) => i.path.includes(fieldName));
}

// ── F1-env: Solana strkey shape ────────────────────────────────────────────

describe('F1-env: Solana strkey validation', () => {
  it('accepts a 56-char base58 key starting with S (SOL secret)', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      SOLANA_TREASURY_SECRET: 'S' + 'A'.repeat(55),
    });
    assert.equal(r.success, true);
  });

  it('accepts the real mainnet USDC issuer default', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      SOLANA_USDC_MINT: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    });
    assert.equal(r.success, true);
  });

  it('rejects a 55-char SOL secret (off by one — historical test fake)', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      SOLANA_TREASURY_SECRET: 'SCZANGBA5RLKPMDUHXOL2BO76RDCGCR7ZA7OMO6TUZBIRGQCQX2LZME',
    });
    assert.equal(r.success, false);
    assert.ok(issueFor(r, 'SOLANA_TREASURY_SECRET'));
  });

  it('rejects a bare "S" (pre-fix this passed .startsWith check)', () => {
    const r = _EnvSchema.safeParse({ ...baseEnv(), SOLANA_TREASURY_SECRET: 'S' });
    assert.equal(r.success, false);
    const issue = issueFor(r, 'SOLANA_TREASURY_SECRET');
    assert.ok(issue);
    assert.match(issue.message, /Solana StrKey/);
  });

  it('rejects a USDC issuer with wrong prefix', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      SOLANA_USDC_MINT: 'X' + 'A'.repeat(55), // 56 chars, base58, but wrong prefix
    });
    assert.equal(r.success, false);
    assert.ok(issueFor(r, 'SOLANA_USDC_MINT'));
  });

  it('rejects a contract id containing 0 (not in base58 alphabet)', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      SOLANA_PROGRAM_ID: 'C' + '0'.repeat(55),
    });
    assert.equal(r.success, false);
    assert.ok(issueFor(r, 'SOLANA_PROGRAM_ID'));
  });

  it('rejects a contract id containing 1 (not in base58 alphabet)', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      SOLANA_PROGRAM_ID: 'C' + '1'.repeat(55),
    });
    assert.equal(r.success, false);
  });

  it('rejects a contract id containing lowercase letters', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      SOLANA_PROGRAM_ID: 'C' + 'a'.repeat(55),
    });
    assert.equal(r.success, false);
  });

  it('rejects 57-char strkey (one too long)', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      SOLANA_PROGRAM_ID: 'C' + 'A'.repeat(56),
    });
    assert.equal(r.success, false);
  });
});

// ── F2-env: INTERNAL_EMAILS per-entry email shape ──────────────────────────

describe('F2-env: INTERNAL_EMAILS per-entry validation', () => {
  it('accepts a single valid email', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      INTERNAL_EMAILS: 'ops@obolus.xyz',
    });
    assert.equal(r.success, true);
  });

  it('accepts a comma-separated list of valid emails', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      INTERNAL_EMAILS: 'ops@obolus.xyz,dev@obolus.xyz,another@example.org',
    });
    assert.equal(r.success, true);
  });

  it('trims whitespace and lowercases', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      INTERNAL_EMAILS: '  Ops@Obolus.COM ,  Dev@obolus.xyz ',
    });
    assert.equal(r.success, true);
    assert.deepEqual(r.data.INTERNAL_EMAILS, ['ops@obolus.xyz', 'dev@obolus.xyz']);
  });

  it('accepts unset INTERNAL_EMAILS (defaults to undefined)', () => {
    const r = _EnvSchema.safeParse(baseEnv());
    assert.equal(r.success, true);
    assert.equal(r.data.INTERNAL_EMAILS, undefined);
  });

  it('rejects a typo missing the @', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      INTERNAL_EMAILS: 'opsobolus.xyz',
    });
    assert.equal(r.success, false);
    assert.ok(issueFor(r, 'INTERNAL_EMAILS'));
  });

  it('rejects a typo missing the dot', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      INTERNAL_EMAILS: 'ops@oboluscom',
    });
    assert.equal(r.success, false);
  });

  it('rejects a list where ONE entry is bad (fail-loud for typos)', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      INTERNAL_EMAILS: 'good@obolus.xyz,broken-entry,another@obolus.xyz',
    });
    assert.equal(r.success, false);
  });

  it('ignores empty entries from trailing commas', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      INTERNAL_EMAILS: 'ops@obolus.xyz,,  ,',
    });
    assert.equal(r.success, true);
    assert.deepEqual(r.data.INTERNAL_EMAILS, ['ops@obolus.xyz']);
  });
});

// ── F3-env: CORS_ORIGINS per-entry origin shape ────────────────────────────

describe('F3-env: CORS_ORIGINS per-entry validation', () => {
  it('accepts a single http URL', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      CORS_ORIGINS: 'http://localhost:3000',
    });
    assert.equal(r.success, true);
  });

  it('accepts a comma-separated list of https URLs', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      CORS_ORIGINS: 'https://obolus.xyz,https://dash.obolus.xyz',
    });
    assert.equal(r.success, true);
  });

  it('rejects a typo (missing scheme)', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      CORS_ORIGINS: 'obolus.xyz',
    });
    assert.equal(r.success, false);
    assert.ok(issueFor(r, 'CORS_ORIGINS'));
  });

  it('rejects a ftp:// origin', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      CORS_ORIGINS: 'ftp://obolus.xyz',
    });
    assert.equal(r.success, false);
  });

  it('rejects a javascript: pseudo-URL', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      CORS_ORIGINS: 'javascript:alert(1)',
    });
    assert.equal(r.success, false);
  });

  it('rejects a list where one entry is bad', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      CORS_ORIGINS: 'https://good.example,BROKEN,https://also-good.example',
    });
    assert.equal(r.success, false);
  });

  it('accepts unset CORS_ORIGINS (defaults to undefined)', () => {
    const r = _EnvSchema.safeParse(baseEnv());
    assert.equal(r.success, true);
  });
});

// ── F4-env: URL scheme constraint ──────────────────────────────────────────

describe('F4-env: http(s)-only URL fields', () => {
  it('accepts https:// OBOLUS_BASE_URL on a reserved test TLD', () => {
    // Using .test (RFC 6761 reserved TLD) so the F5-env production-
    // lookalike guard doesn't fire under NODE_ENV=test. A real
    // production URL like obolus.xyz would correctly trip that
    // guard under NODE_ENV=test and is covered by the F5 test below.
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      OBOLUS_BASE_URL: 'https://api.obolus.test',
    });
    assert.equal(r.success, true, JSON.stringify(r.success ? null : r.error.issues));
  });

  it('accepts http:// OBOLUS_BASE_URL (dev mode)', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      OBOLUS_BASE_URL: 'http://localhost:4000',
    });
    assert.equal(r.success, true);
  });

  it('rejects ftp:// OBOLUS_BASE_URL', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      OBOLUS_BASE_URL: 'ftp://obolus.xyz',
    });
    assert.equal(r.success, false);
    assert.ok(issueFor(r, 'OBOLUS_BASE_URL'));
  });

  it('rejects file:// VCC_API_BASE', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      VCC_API_BASE: 'file:///etc/passwd',
    });
    assert.equal(r.success, false);
    assert.ok(issueFor(r, 'VCC_API_BASE'));
  });

  it('rejects chrome-extension:// SOLANA_RPC_URL', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      SOLANA_RPC_URL: 'chrome-extension://abc/page',
    });
    assert.equal(r.success, false);
  });

  it('accepts unset optional SOLANA_RPC_URL', () => {
    const e = baseEnv();
    delete e.SOLANA_RPC_URL;
    const r = _EnvSchema.safeParse(e);
    assert.equal(r.success, true);
  });
});

// ── F5-env: RFC 6761 reserved TLDs treated as local ────────────────────────
//
// Pre-fix, the production-lookalike guard treated any HTTPS non-
// localhost, non-.local hostname as a production deploy and
// required NODE_ENV=production. But RFC 6761 reserves `.test`,
// `.localhost`, `.invalid`, and `.example` for testing and docs —
// an HTTPS URL on `.test` is unambiguously a test deploy. Pre-fix
// this misclassification only surfaced if something required
// src/env.js from a test process (historically, nothing did); this
// test file is the first to do so.

describe('F5-env: reserved TLDs are treated as local', () => {
  it('accepts https://api.obolus.test under NODE_ENV=test', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      OBOLUS_BASE_URL: 'https://api.obolus.test',
    });
    assert.equal(r.success, true);
  });

  it('accepts https://api.obolus.localhost under NODE_ENV=test', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      OBOLUS_BASE_URL: 'https://api.obolus.localhost',
    });
    assert.equal(r.success, true);
  });

  it('accepts https://[::1] under NODE_ENV=test (IPv6 localhost)', () => {
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      OBOLUS_BASE_URL: 'https://[::1]',
    });
    assert.equal(r.success, true);
  });

  it('rejects https://api.obolus.xyz under NODE_ENV=test (real prod URL)', () => {
    // The guard still correctly fires on a real production URL — this
    // is the whole point of the check and must not regress.
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      OBOLUS_BASE_URL: 'https://api.obolus.xyz',
    });
    assert.equal(r.success, false);
    assert.ok(issueFor(r, 'NODE_ENV'));
  });

  it('accepts https://api.obolus.xyz under NODE_ENV=production', () => {
    // With NODE_ENV=production, the guard doesn't fire. But production
    // also requires OBOLUS_SECRET_BOX_KEY, so include it.
    const r = _EnvSchema.safeParse({
      ...baseEnv(),
      NODE_ENV: 'production',
      OBOLUS_BASE_URL: 'https://api.obolus.xyz',
      OBOLUS_SECRET_BOX_KEY: 'a'.repeat(64),
    });
    assert.equal(r.success, true);
  });
});

// ── Baseline: existing validations still fire ───────────────────────────────

describe('env schema — baseline regression guards', () => {
  it('accepts the full baseEnv', () => {
    const r = _EnvSchema.safeParse(baseEnv());
    assert.equal(r.success, true);
  });

  it('rejects missing NODE_ENV', () => {
    const e = baseEnv();
    delete e.NODE_ENV;
    const r = _EnvSchema.safeParse(e);
    assert.equal(r.success, false);
  });

  it('rejects missing SOLANA_TREASURY_SECRET', () => {
    const e = baseEnv();
    delete e.SOLANA_TREASURY_SECRET;
    const r = _EnvSchema.safeParse(e);
    assert.equal(r.success, false);
  });

  it('rejects a VCC_CALLBACK_SECRET shorter than 32 chars', () => {
    const r = _EnvSchema.safeParse({ ...baseEnv(), VCC_CALLBACK_SECRET: 'too-short' });
    assert.equal(r.success, false);
  });

  it('rejects a non-numeric PORT', () => {
    const r = _EnvSchema.safeParse({ ...baseEnv(), PORT: 'abc' });
    assert.equal(r.success, false);
  });
});
