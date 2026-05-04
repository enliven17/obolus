// OWS (Open Wallet Standard) wallet integration for obolus.
//
// Agents use an OWS wallet instead of a raw private key env var:
//   - Keys are encrypted at rest in the OWS vault file
//   - Ed25519 keypairs for Solana
//   - Supports passphrase protection and vault path override
//
// Signing: @solana/web3.js handles transaction building and signing.

import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import {
  createWallet as owsCreate,
  getWallet as owsGet,
  importWalletPrivateKey,
  signTransaction as owsSign,
  type WalletInfo,
} from '@obolus/solana-ows-core';

import type { CardDetails, PaymentInstructions } from './client';
import { ResumableError, OrderFailedError, ObolusError } from './errors';
import {
  buildContractPaymentTx,
  submitSolanaTx,
  decimalToLamports,
  selectContractCall,
  getSolanaRpcUrl,
  InsufficientFeeError,
} from './solana';

const SOLANA_CHAIN = 'solana';

function withTimeout<T>(promise: Promise<T>, ms = 15000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Solana RPC request timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ── Wallet helpers ────────────────────────────────────────────────────────────

/** Extract the Solana base58 public key from an OWS WalletInfo. */
function getSolanaAddress(wallet: WalletInfo): string {
  const account = wallet.accounts.find((a) => a.chainId.includes('solana'));
  if (!account) throw new Error(`OWS wallet "${wallet.name}" has no Solana account`);
  return account.address;
}

/**
 * Create an OWS wallet, or return the existing one if a wallet with this
 * name already exists in the vault. Idempotent — calling it twice with
 * the same name is safe and returns the same keys.
 */
export function createOWSWallet(
  name: string,
  passphrase?: string,
  vaultPath?: string,
): { walletId: string; publicKey: string } {
  try {
    const existing = owsGet(name, vaultPath ?? null);
    return { walletId: existing.id, publicKey: getSolanaAddress(existing) };
  } catch {
    /* not found — fall through to create */
  }
  const wallet = owsCreate(name, passphrase ?? null, undefined, vaultPath ?? null);
  return { walletId: wallet.id, publicKey: getSolanaAddress(wallet) };
}

/**
 * Import an existing Solana secret key (base58) into an OWS wallet.
 * Useful for migrating from a raw SOLANA_AGENT_SECRET to OWS custody.
 */
export function importSolanaKey(
  name: string,
  solanaSecret: string,
  passphrase?: string,
  vaultPath?: string,
): { walletId: string; publicKey: string } {
  const keypair = Keypair.fromSecretKey(Buffer.from(solanaSecret, 'base58'));
  const ed25519KeyHex = Buffer.from(keypair.secretKey.slice(0, 32)).toString('hex');
  const wallet = importWalletPrivateKey(
    name,
    '',
    passphrase ?? null,
    vaultPath ?? null,
    SOLANA_CHAIN,
    null,
    ed25519KeyHex,
  );
  return { walletId: wallet.id, publicKey: getSolanaAddress(wallet) };
}

/** @deprecated Use importSolanaKey */

/** Get the Solana base58 public key for a named OWS wallet. */
export function getOWSPublicKey(walletName: string, vaultPath?: string): string {
  const wallet = owsGet(walletName, vaultPath ?? null);
  return getSolanaAddress(wallet);
}

/** Check SOL and USDC balances for an OWS wallet. */
export async function getOWSBalance(
  walletName: string,
  vaultPath?: string,
  rpcUrl?: string,
): Promise<{ sol: string; usdc: string }> {
  const publicKey = new PublicKey(getOWSPublicKey(walletName, vaultPath));
  const connection = new Connection(rpcUrl ?? clusterApiUrl('mainnet-beta'), 'confirmed');

  const lamports = await withTimeout(connection.getBalance(publicKey));
  const sol = (lamports / LAMPORTS_PER_SOL).toFixed(9);

  // USDC token account balance
  let usdc = '0';
  try {
    const usdcMint = new PublicKey(
      process.env.SOLANA_USDC_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    const ata = await getAssociatedTokenAddress(usdcMint, publicKey);
    const info = await withTimeout(connection.getTokenAccountBalance(ata));
    usdc = info.value.uiAmountString ?? '0';
  } catch {
    /* no USDC token account yet */
  }

  return { sol, usdc };
}

// ── Onboarding helper ─────────────────────────────────────────────────────────

export interface OnboardAgentOpts {
  apiKey: string;
  walletName: string;
  baseUrl?: string;
  passphrase?: string;
  vaultPath?: string;
}

export interface OnboardAgentResult {
  publicKey: string;
  balance: { sol: string; usdc: string };
}

/**
 * One-shot agent setup: reports `initializing` to obolus, creates or
 * fetches the OWS wallet, reports `awaiting_funding` with the wallet
 * address, and returns the public key + current balance. Idempotent.
 */
export async function onboardAgent(opts: OnboardAgentOpts): Promise<OnboardAgentResult> {
  const { ObolusClient } = await import('./client');
  const client = new ObolusClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });

  await client.reportStatus('initializing', { detail: 'creating wallet' });

  const { publicKey } = createOWSWallet(opts.walletName, opts.passphrase, opts.vaultPath);

  let balance = { sol: '0', usdc: '0' };
  try {
    balance = await getOWSBalance(opts.walletName, opts.vaultPath);
  } catch {
    /* unactivated account — normal on first run */
  }

  await client.reportStatus('awaiting_funding', {
    wallet_public_key: publicKey,
    detail: `sol=${balance.sol} usdc=${balance.usdc}`,
  });

  return { publicKey, balance };
}

// ── Signing bridge ────────────────────────────────────────────────────────────

function owsSignTx(
  tx: Transaction,
  walletName: string,
  publicKey: string,
  passphrase?: string,
  vaultPath?: string,
): void {
  const serialized = tx.serialize({ requireAllSignatures: false }).toString('hex');
  const { signature: sigHex } = owsSign(
    walletName,
    SOLANA_CHAIN,
    serialized,
    passphrase ?? null,
    null,
    vaultPath ?? null,
  );
  const pubKey = new PublicKey(publicKey);
  tx.addSignature(pubKey, Buffer.from(sigHex, 'hex'));
}

// ── Solana tx landed-check ────────────────────────────────────────────────────

export async function checkSolanaTxLanded(
  txHash: string,
  opts: { rpcUrl?: string } = {},
): Promise<'landed' | 'dropped' | 'pending'> {
  try {
    const connection = new Connection(
      opts.rpcUrl ?? clusterApiUrl('mainnet-beta'),
      'confirmed',
    );
    const status = await withTimeout(connection.getSignatureStatus(txHash));
    if (!status.value) return 'dropped';
    if (status.value.err) return 'dropped';
    return 'landed';
  } catch {
    return 'pending';
  }
}

// ── USDC token account ────────────────────────────────────────────────────────

export interface TokenAccountOpts {
  walletName: string;
  passphrase?: string;
  vaultPath?: string;
  rpcUrl?: string;
}

export async function addUsdcTokenAccountOWS(opts: TokenAccountOpts): Promise<string | null> {
  const { walletName, passphrase, vaultPath, rpcUrl } = opts;
  const publicKey = new PublicKey(getOWSPublicKey(walletName, vaultPath));
  const connection = new Connection(rpcUrl ?? clusterApiUrl('mainnet-beta'), 'confirmed');
  const usdcMint = new PublicKey(
    process.env.SOLANA_USDC_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  );

  const ata = await getAssociatedTokenAddress(usdcMint, publicKey);
  const existing = await connection.getAccountInfo(ata);
  if (existing) return null; // already has token account

  const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey });
  tx.add(
    createAssociatedTokenAccountInstruction(publicKey, ata, publicKey, usdcMint),
  );

  owsSignTx(tx, walletName, publicKey.toBase58(), passphrase, vaultPath);
  const sig = await withTimeout(
    connection.sendRawTransaction(tx.serialize()),
  );
  return sig;
}

// ── All-in-one ────────────────────────────────────────────────────────────────

const PAY_VIA_CONTRACT_MAX_ATTEMPTS = 3;
const PAY_VIA_CONTRACT_RETRY_DELAY_MS = 6_000;

export interface PayViaContractOwsOpts {
  walletName: string;
  payment: PaymentInstructions;
  paymentAsset?: 'usdc' | 'sol';
  passphrase?: string;
  vaultPath?: string;
  rpcUrl?: string;
}

export interface PayViaContractOwsDeps {
  buildContractPaymentTx?: typeof buildContractPaymentTx;
  submitSolanaTx?: typeof submitSolanaTx;
  owsSignTx?: (tx: Transaction, walletName: string, publicKey: string, passphrase?: string, vaultPath?: string) => void;
  getOWSPublicKey?: (walletName: string, vaultPath?: string) => string;
}

export async function payViaContractOWS(
  opts: PayViaContractOwsOpts,
  deps: PayViaContractOwsDeps = {},
): Promise<string> {
  const { walletName, payment, paymentAsset = 'usdc', passphrase, vaultPath, rpcUrl } = opts;

  const buildTx = deps.buildContractPaymentTx ?? buildContractPaymentTx;
  const submitTx = deps.submitSolanaTx ?? submitSolanaTx;
  const signTx = deps.owsSignTx ?? owsSignTx;
  const pubKeyOf = deps.getOWSPublicKey ?? getOWSPublicKey;

  const publicKey = pubKeyOf(walletName, vaultPath);
  const { fn, amountDecimal } = selectContractCall(payment, paymentAsset);
  const amountLamports = decimalToLamports(amountDecimal);

  let preservedSequence: string | undefined;
  let suggestedFee: string | undefined;
  let lastErr: unknown;

  for (let attempt = 0; attempt < PAY_VIA_CONTRACT_MAX_ATTEMPTS; attempt++) {
    const { tx, server } = await buildTx({
      contractId: payment.contract_id,
      fn,
      fromPublicKey: publicKey,
      amountLamports,
      orderId: payment.order_id,
      rpcUrl,
      preservedSequence,
      fee: suggestedFee,
    });
    const thisSeq = (tx as any).sequence;

    signTx(tx, walletName, publicKey, passphrase, vaultPath);

    try {
      return await submitTx(tx, server, getSolanaRpcUrl(rpcUrl));
    } catch (err) {
      lastErr = err;
      if (err instanceof InsufficientFeeError) {
        if (attempt >= PAY_VIA_CONTRACT_MAX_ATTEMPTS - 1) throw err;
        suggestedFee = err.requiredFee;
        continue;
      }
      const dropped = (err as Error & { dropped?: boolean })?.dropped === true;
      if (!dropped) throw err;
      preservedSequence = thisSeq;
      if (attempt >= PAY_VIA_CONTRACT_MAX_ATTEMPTS - 1) throw err;
      await new Promise((r) => setTimeout(r, PAY_VIA_CONTRACT_RETRY_DELAY_MS));
    }
  }
  throw lastErr ?? new Error('payViaContractOWS: retry loop exited without result');
}

/** @deprecated Use payViaContractOWS */
export const payVCCOWS = payViaContractOWS;
/** @deprecated */
export type PayVCCOwsOpts = PayViaContractOwsOpts;

export interface PurchaseCardOwsOpts {
  apiKey: string;
  walletName: string;
  amountUsdc: string;
  paymentAsset?: 'usdc' | 'sol';
  passphrase?: string;
  vaultPath?: string;
  baseUrl?: string;
  rpcUrl?: string;
  resume?:
    | string
    | { orderId: string; payment?: PaymentInstructions; txHash?: string; phase?: 'unpaid' | 'paid' };
  waitForCardOpts?: { timeoutMs?: number; intervalMs?: number };
}

export async function purchaseCardOWS(
  opts: PurchaseCardOwsOpts,
): Promise<CardDetails & { order_id: string }> {
  const { ObolusClient } = await import('./client');
  const client = new ObolusClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const paymentAsset = opts.paymentAsset ?? 'usdc';

  let orderId: string;
  let payment: PaymentInstructions | undefined;
  let skipPayment = false;

  if (opts.resume) {
    let priorTxHash: string | undefined;
    let priorPhase: 'unpaid' | 'paid' | undefined;
    if (typeof opts.resume === 'string') {
      orderId = opts.resume;
    } else {
      orderId = opts.resume.orderId;
      payment = opts.resume.payment;
      priorTxHash = opts.resume.txHash;
      priorPhase = opts.resume.phase;
    }
    const status = await client.getOrder(orderId);
    if (status.phase === 'ready' && status.card) return { ...status.card, order_id: orderId };
    if (['failed', 'refunded', 'rejected', 'expired'].includes(status.phase ?? '')) {
      throw new OrderFailedError(orderId, status.error ?? status.phase ?? 'failed', status.refund);
    }
    if (status.phase !== 'awaiting_payment') {
      skipPayment = true;
    } else if (payment) {
      // caller supplied fresh payment — resubmit
    } else if (priorTxHash && priorPhase === 'unpaid') {
      const landed = await checkSolanaTxLanded(priorTxHash, { rpcUrl: opts.rpcUrl });
      if (landed === 'landed') {
        skipPayment = true;
      } else if (landed === 'dropped' && status.payment) {
        payment = status.payment;
      } else {
        skipPayment = true;
      }
    } else {
      skipPayment = true;
    }
  } else {
    const order = await client.createOrder({ amount_usdc: opts.amountUsdc });
    orderId = order.order_id;
    payment = order.payment;
  }

  if (!skipPayment) {
    if (!payment) {
      throw new ResumableError(orderId, 'internal: payment instructions missing', 'unpaid');
    }
    try {
      await payViaContractOWS({ walletName: opts.walletName, payment, paymentAsset, passphrase: opts.passphrase, vaultPath: opts.vaultPath, rpcUrl: opts.rpcUrl });
    } catch (err) {
      const errWithHash = err as Error & { txHash?: string; dropped?: boolean };
      const hasHash = typeof errWithHash.txHash === 'string';
      const dropped = errWithHash.dropped === true;
      if (!hasHash || dropped) {
        throw new ResumableError(orderId, err instanceof Error ? err.message : String(err), 'unpaid', errWithHash.txHash, err);
      }
    }
  }

  try {
    const card = await client.waitForCard(orderId, opts.waitForCardOpts);
    return { ...card, order_id: orderId };
  } catch (err) {
    if (err instanceof OrderFailedError) throw err;
    if (err instanceof ObolusError && err.code !== 'wait_timeout') throw err;
    throw new ResumableError(orderId, err instanceof Error ? err.message : String(err), 'paid', undefined, err);
  }
}
