// @ts-check
// Solana payment watcher — polls the Obolus Anchor program for PaymentReceived events.
//
// Anchor emits events as base64 in program logs: "Program data: <base64>"
// We decode these directly without BorshCoder to avoid IDL version issues.

const { Connection, PublicKey } = require('@solana/web3.js');
const { event: bizEvent } = require('../lib/logger');
const db = require('../db');

const NETWORK = process.env.SOLANA_NETWORK || 'devnet';
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  (NETWORK === 'mainnet-beta'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com');

const POLL_MS = 3000;
const BACKOFF_MS = 12000;

// ── Cursor persistence ────────────────────────────────────────────────────────

function loadLastSignature() {
  const row = /** @type {any} */ (
    db.prepare(`SELECT value FROM system_state WHERE key = 'solana_last_signature'`).get()
  );
  return row?.value || null;
}

function saveLastSignature(sig) {
  db.prepare(
    `INSERT OR REPLACE INTO system_state (key, value) VALUES ('solana_last_signature', ?)`,
  ).run(sig);
  db.prepare(
    `INSERT OR REPLACE INTO system_state (key, value) VALUES ('solana_last_sig_at', ?)`,
  ).run(new Date().toISOString());
}

// ── Event parsing from Anchor logs ───────────────────────────────────────────
//
// Anchor serializes events as:
//   "Program data: <base64(discriminator[8] + borsh_payload)>"
//
// PaymentReceived layout (Borsh):
//   order_id : [u8; 32]
//   payer    : [u8; 32]  (Pubkey)
//   amount   : u64 LE
//   asset    : u8        (0 = Usdc, 1 = Sol)

const PROGRAM_DATA_PREFIX = 'Program data: ';

function parsePaymentEvent(log) {
  if (!log.startsWith(PROGRAM_DATA_PREFIX)) return null;
  try {
    const b64 = log.slice(PROGRAM_DATA_PREFIX.length).trim();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 8 + 32 + 32 + 8 + 1) return null;

    // Skip 8-byte discriminator
    let offset = 8;
    const orderIdBytes = buf.slice(offset, offset + 32); offset += 32;
    const payerBytes  = buf.slice(offset, offset + 32); offset += 32;
    const amount      = buf.readBigUInt64LE(offset);    offset += 8;
    const assetByte   = buf[offset];

    const orderId = orderIdBytes.toString('utf8').replace(/\0/g, '').trim();
    const payer   = new PublicKey(payerBytes).toBase58();
    const isUsdc  = assetByte === 0;

    if (!orderId) return null;

    return {
      orderId,
      payer,
      amount,
      paymentAsset: isUsdc ? 'usdc_solana' : 'sol_solana',
      amountUsdc: isUsdc  ? (Number(amount) / 1_000_000).toFixed(6) : null,
      amountSol:  !isUsdc ? (Number(amount) / 1_000_000_000).toFixed(9) : null,
    };
  } catch {
    return null;
  }
}

function extractPaymentEvents(logs) {
  if (!Array.isArray(logs)) return [];
  return logs.flatMap((log) => {
    const ev = parsePaymentEvent(log);
    return ev ? [ev] : [];
  });
}

// ── Watcher ───────────────────────────────────────────────────────────────────

/**
 * Start the Solana payment watcher.
 * @param {(payment: object) => Promise<void>} onPayment
 * @returns {() => void} stop function
 */
function startWatcher(onPayment) {
  const programId = process.env.SOLANA_PROGRAM_ID;
  if (!programId) {
    console.warn('[solana] SOLANA_PROGRAM_ID not set — watcher disabled');
    return () => {};
  }

  const connection = new Connection(RPC_URL, 'confirmed');
  const programPubkey = new PublicKey(programId);

  let shutdownRequested = false;
  let pollTimer = null;

  async function poll() {
    if (shutdownRequested) return;

    try {
      const lastSig = loadLastSignature();
      const opts = { limit: 50, commitment: /** @type {any} */ ('confirmed') };
      if (lastSig) opts.until = lastSig;

      const signatures = await connection.getSignaturesForAddress(programPubkey, opts);
      if (!signatures.length) {
        schedule(POLL_MS);
        return;
      }

      // Process oldest-first
      const ordered = [...signatures].reverse();
      for (const sigInfo of ordered) {
        if (shutdownRequested) break;
        if (sigInfo.err) {
          saveLastSignature(sigInfo.signature);
          continue;
        }

        try {
          const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });

          const logs = tx?.meta?.logMessages || [];
          const events = extractPaymentEvents(logs);

          for (const ev of events) {
            bizEvent('solana.payment_event', {
              sig: sigInfo.signature,
              order_id: ev.orderId,
              asset: ev.paymentAsset,
              amount_usdc: ev.amountUsdc,
              amount_sol: ev.amountSol,
            });

            await onPayment({
              txid: sigInfo.signature,
              paymentAsset: ev.paymentAsset,
              amountUsdc: ev.amountUsdc,
              amountSol: ev.amountSol,
              senderAddress: ev.payer,
              orderId: ev.orderId,
            });
          }
        } catch (err) {
          try {
            db.prepare(
              `INSERT OR IGNORE INTO solana_dead_letter
                 (tx_hash, ledger, raw_event, error, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            ).run(
              sigInfo.signature,
              sigInfo.slot,
              JSON.stringify({ sig: sigInfo.signature }),
              err?.message || String(err),
              new Date().toISOString(),
            );
          } catch { /* best-effort */ }
          bizEvent('solana.parse_error', { sig: sigInfo.signature, error: err?.message });
          console.error(`[solana] tx ${sigInfo.signature.slice(0, 16)}… error: ${err?.message}`);
        }

        saveLastSignature(sigInfo.signature);
      }

      schedule(POLL_MS);
    } catch (err) {
      console.error('[solana] poll error:', err?.message);
      schedule(BACKOFF_MS);
    }
  }

  function schedule(ms) {
    if (!shutdownRequested) {
      pollTimer = setTimeout(poll, ms);
    }
  }

  db.prepare(
    `INSERT OR REPLACE INTO system_state (key, value) VALUES ('solana_last_sig_at', ?)`,
  ).run(new Date().toISOString());

  poll();
  console.log(`[solana] watcher started — program ${programId} (${NETWORK})`);

  return function stop() {
    shutdownRequested = true;
    if (pollTimer) clearTimeout(pollTimer);
    console.log('[solana] watcher stopped');
  };
}

module.exports = { startWatcher };
