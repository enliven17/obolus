// Unit tests for the 2026-04-16 checkAgentFundingStatus hardening.
//
//   F1-funding: use the SOLANA_USDC_MINT env var (and a testnet-
//               aware Solana RPC base URL) instead of the hardcoded
//               mainnet issuer. Pre-fix, testnet deployments silently
//               failed to detect USDC funding because the issuer
//               never matched.
//
//   F2-funding: Solana RPC HTTP errors are now dedup'd and emit a
//               `funding.horizon_error` bizEvent. Pre-fix, a Solana RPC
//               outage silently `continue`d on every awaiting wallet
//               with zero ops signal. 404 is still quiet (expected
//               "wallet unactivated"); 429/500/503 and network
//               exceptions alert once per outage window.

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { db, resetDb, createTestKey } = require('../helpers/app');

const {
  checkAgentFundingStatus,
  _resetFundingSolana RPCOutageState,
  _horizonBase,
  _MAINNET_USDC_ISSUER,
} = require('../../src/jobs');

// ── Fetch stub ─────────────────────────────────────────────────────────────

const realFetch = global.fetch;
const fetchCalls = [];
let fetchImpl = null;

global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  if (!fetchImpl) {
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    };
  }
  return fetchImpl(String(url), opts);
};

function mockFetch(impl) {
  fetchImpl = impl;
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => '',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function seedAwaitingAgent(walletKey) {
  const { id } = await createTestKey({ label: 'awaiting' });
  db.prepare(
    `UPDATE api_keys SET agent_state = 'awaiting_funding', wallet_public_key = ? WHERE id = ?`,
  ).run(walletKey, id);
  return id;
}

function getAgentState(id) {
  return /** @type {any} */ (
    db.prepare(`SELECT agent_state, agent_state_detail FROM api_keys WHERE id = ?`).get(id)
  );
}

// ── Logger capture ─────────────────────────────────────────────────────────

let origLoggerEvent;
let capturedEvents;

function captureBizEvents() {
  const logger = require('../../src/lib/logger');
  origLoggerEvent = logger.event;
  capturedEvents = [];
  logger.event = (name, fields) => capturedEvents.push({ name, fields });
}

function restoreBizEvents() {
  const logger = require('../../src/lib/logger');
  logger.event = origLoggerEvent;
}

// ── Common setup ──────────────────────────────────────────────────────────

let origNetwork;
let origIssuer;

beforeEach(() => {
  resetDb();
  fetchCalls.length = 0;
  fetchImpl = null;
  _resetFundingSolana RPCOutageState();
  origNetwork = process.env.SOLANA_NETWORK;
  origIssuer = process.env.SOLANA_USDC_MINT;
  captureBizEvents();
});

afterEach(() => {
  if (origNetwork === undefined) delete process.env.SOLANA_NETWORK;
  else process.env.SOLANA_NETWORK = origNetwork;
  if (origIssuer === undefined) delete process.env.SOLANA_USDC_MINT;
  else process.env.SOLANA_USDC_MINT = origIssuer;
  restoreBizEvents();
});

// ── F1-funding: env-configurable USDC issuer + network-aware base ─────────

describe('F1-funding: env-configurable Solana RPC base URL', () => {
  it('uses mainnet Solana RPC when SOLANA_NETWORK is unset', () => {
    delete process.env.SOLANA_NETWORK;
    assert.equal(_horizonBase(), 'https://horizon.solana.org');
  });

  it('uses mainnet Solana RPC when SOLANA_NETWORK=mainnet', () => {
    process.env.SOLANA_NETWORK = 'mainnet';
    assert.equal(_horizonBase(), 'https://horizon.solana.org');
  });

  it('uses testnet Solana RPC when SOLANA_NETWORK=testnet', () => {
    process.env.SOLANA_NETWORK = 'testnet';
    assert.equal(_horizonBase(), 'https://horizon-testnet.solana.org');
  });
});

describe('F1-funding: env-configurable USDC issuer', () => {
  it('hits the mainnet Solana RPC URL when SOLANA_NETWORK=mainnet', async () => {
    process.env.SOLANA_NETWORK = 'mainnet';
    await seedAwaitingAgent('GWALLET_A');
    mockFetch(() => errorResponse(404));
    await checkAgentFundingStatus();
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /^https:\/\/horizon\.solana\.org\/accounts\/GWALLET_A$/);
  });

  it('hits the testnet Solana RPC URL when SOLANA_NETWORK=testnet', async () => {
    process.env.SOLANA_NETWORK = 'testnet';
    await seedAwaitingAgent('GWALLET_B');
    mockFetch(() => errorResponse(404));
    await checkAgentFundingStatus();
    assert.equal(fetchCalls.length, 1);
    assert.match(
      fetchCalls[0].url,
      /^https:\/\/horizon-testnet\.solana\.org\/accounts\/GWALLET_B$/,
    );
  });

  it('detects USDC funding using a testnet-specific issuer from env', async () => {
    process.env.SOLANA_NETWORK = 'testnet';
    // Fake testnet USDC issuer (shape-valid 56-char G-key).
    const TESTNET_USDC = 'G' + 'T'.repeat(55);
    process.env.SOLANA_USDC_MINT = TESTNET_USDC;

    const agentId = await seedAwaitingAgent('GWALLET_TESTNET');
    mockFetch(() =>
      okResponse({
        balances: [
          { asset_type: 'native', balance: '0.5000000' }, // below 2 SOL floor
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: TESTNET_USDC,
            balance: '10.5000000',
          },
        ],
      }),
    );

    await checkAgentFundingStatus();

    // Agent should be funded — pre-fix, the hardcoded mainnet issuer
    // never matched this entry and the agent stayed in awaiting_funding
    // forever despite having USDC on testnet.
    const state = getAgentState(agentId);
    assert.equal(state.agent_state, 'funded');
    assert.match(state.agent_state_detail, /usdc=10\.50/);
  });

  it('does NOT match mainnet USDC balance on a testnet deploy (isolation)', async () => {
    process.env.SOLANA_NETWORK = 'testnet';
    const TESTNET_USDC = 'G' + 'T'.repeat(55);
    process.env.SOLANA_USDC_MINT = TESTNET_USDC;

    const agentId = await seedAwaitingAgent('GWALLET_MIX');
    mockFetch(() =>
      okResponse({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            // Mainnet issuer — must NOT match on a testnet deploy.
            asset_issuer: _MAINNET_USDC_ISSUER,
            balance: '10.00',
          },
        ],
      }),
    );

    await checkAgentFundingStatus();
    // Agent stays awaiting — we only fund on the configured issuer.
    assert.equal(getAgentState(agentId).agent_state, 'awaiting_funding');
  });

  it('still matches mainnet USDC when SOLANA_USDC_MINT is unset', async () => {
    delete process.env.SOLANA_USDC_MINT;
    const agentId = await seedAwaitingAgent('GWALLET_DEFAULT');
    mockFetch(() =>
      okResponse({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: _MAINNET_USDC_ISSUER,
            balance: '5.00',
          },
        ],
      }),
    );
    await checkAgentFundingStatus();
    assert.equal(getAgentState(agentId).agent_state, 'funded');
  });
});

// ── F2-funding: Solana RPC HTTP error observability ──────────────────────────

describe('F2-funding: Solana RPC error alerting', () => {
  it('is QUIET on 404 (unactivated wallet — expected)', async () => {
    await seedAwaitingAgent('GWALLET_UNACTIVATED');
    mockFetch(() => errorResponse(404));
    await checkAgentFundingStatus();
    // No bizEvent.
    assert.equal(capturedEvents.filter((e) => e.name === 'funding.horizon_error').length, 0);
  });

  it('emits funding.horizon_error on HTTP 500', async () => {
    await seedAwaitingAgent('GWALLET_500');
    mockFetch(() => errorResponse(500));
    await checkAgentFundingStatus();
    const err = capturedEvents.find((e) => e.name === 'funding.horizon_error');
    assert.ok(err, 'expected horizon_error event on HTTP 500');
    assert.equal(err.fields.status, 500);
  });

  it('emits funding.horizon_error on HTTP 429 (rate limit)', async () => {
    await seedAwaitingAgent('GWALLET_429');
    mockFetch(() => errorResponse(429));
    await checkAgentFundingStatus();
    const err = capturedEvents.find((e) => e.name === 'funding.horizon_error');
    assert.ok(err);
    assert.equal(err.fields.status, 429);
  });

  it('emits exactly ONE horizon_error per outage (dedup across awaiting rows)', async () => {
    // Three awaiting agents; Solana RPC returns 503 for all of them.
    // Pre-fix: zero bizEvents. Post-fix: one per outage, not per agent.
    await seedAwaitingAgent('GWALLET_A');
    await seedAwaitingAgent('GWALLET_B');
    await seedAwaitingAgent('GWALLET_C');
    mockFetch(() => errorResponse(503));
    await checkAgentFundingStatus();
    const errs = capturedEvents.filter((e) => e.name === 'funding.horizon_error');
    assert.equal(errs.length, 1, `expected 1 deduped horizon_error, got ${errs.length}`);
  });

  it('clears the outage flag on recovery and emits funding.horizon_recovered', async () => {
    await seedAwaitingAgent('GWALLET_RECOVER');

    // First tick: Solana RPC is down (503).
    mockFetch(() => errorResponse(503));
    await checkAgentFundingStatus();
    assert.ok(capturedEvents.some((e) => e.name === 'funding.horizon_error'));

    // Second tick: Solana RPC is back, wallet is unfunded but the fetch
    // succeeds. We expect a `funding.horizon_recovered` bizEvent.
    capturedEvents.length = 0;
    mockFetch(() =>
      okResponse({
        balances: [{ asset_type: 'native', balance: '0.1' }],
      }),
    );
    await checkAgentFundingStatus();
    assert.ok(
      capturedEvents.some((e) => e.name === 'funding.horizon_recovered'),
      `expected horizon_recovered event on first successful fetch after outage`,
    );
  });

  it('re-alerts on a NEW outage after recovery', async () => {
    await seedAwaitingAgent('GWALLET_FLAP');

    // Outage 1.
    mockFetch(() => errorResponse(500));
    await checkAgentFundingStatus();
    assert.equal(capturedEvents.filter((e) => e.name === 'funding.horizon_error').length, 1);

    // Recovery.
    mockFetch(() => okResponse({ balances: [{ asset_type: 'native', balance: '0.1' }] }));
    await checkAgentFundingStatus();

    // Outage 2 — must emit a fresh error event, not be suppressed
    // by the first outage's dedup state.
    capturedEvents.length = 0;
    mockFetch(() => errorResponse(500));
    await checkAgentFundingStatus();
    assert.equal(
      capturedEvents.filter((e) => e.name === 'funding.horizon_error').length,
      1,
      'second outage must re-alert after recovery cleared the dedup flag',
    );
  });

  it('emits horizon_error when fetch itself throws (network/timeout)', async () => {
    await seedAwaitingAgent('GWALLET_NETWORK');
    // Silence the expected console.error line.
    const origErr = console.error;
    console.error = () => {};
    try {
      mockFetch(() => {
        throw new Error('connect ECONNREFUSED');
      });
      await checkAgentFundingStatus();
    } finally {
      console.error = origErr;
    }
    const err = capturedEvents.find((e) => e.name === 'funding.horizon_error');
    assert.ok(err);
    assert.equal(err.fields.status, 'exception');
    assert.match(err.fields.error, /ECONNREFUSED/);
  });
});

// Restore real fetch on process exit.
process.on('exit', () => {
  global.fetch = realFetch;
});
