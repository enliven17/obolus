// @ts-check
// Solana treasury sender — sends USDC or SOL from the treasury wallet.
// Used for refunds to agents.

const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getMint,
} = require('@solana/spl-token');
const { event: bizEvent } = require('../lib/logger');

const NETWORK = process.env.SOLANA_NETWORK || 'devnet';
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  (NETWORK === 'mainnet-beta'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com');

const connection = new Connection(RPC_URL, 'confirmed');

function getTreasuryKeypair() {
  const secret = process.env.SOLANA_TREASURY_SECRET;
  if (!secret) throw new Error('SOLANA_TREASURY_SECRET not set');
  // Support both base58 and byte-array formats
  const { Keypair: KP } = require('@solana/web3.js');
  const bs58 = require('bs58');
  try {
    return KP.fromSecretKey(bs58.decode(secret));
  } catch {
    // Try hex
    const bytes = Buffer.from(secret, 'hex');
    return KP.fromSecretKey(bytes);
  }
}

function getUsdcMint() {
  const mint = process.env.SOLANA_USDC_MINT;
  if (!mint) throw new Error('SOLANA_USDC_MINT not set');
  return new PublicKey(mint);
}

/**
 * Send SOL from treasury to destination.
 * @param {{ destination: string, amount: string, memo?: string }} params
 * @returns {Promise<string>} transaction signature
 */
async function sendSol({ destination, amount, memo }) {
  const keypair = getTreasuryKeypair();
  const destPubkey = new PublicKey(destination);
  const lamports = Math.round(parseFloat(amount) * LAMPORTS_PER_SOL);

  if (lamports <= 0) throw new Error(`sendSol: invalid amount '${amount}'`);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: destPubkey,
      lamports,
    }),
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
  bizEvent('treasury.sol_sent', { destination, amount, sig });
  return sig;
}

/**
 * Send USDC SPL token from treasury to destination.
 * @param {{ destination: string, amount: string, memo?: string }} params
 * @returns {Promise<string>} transaction signature
 */
async function sendUsdc({ destination, amount, memo }) {
  const keypair = getTreasuryKeypair();
  const destPubkey = new PublicKey(destination);
  const usdcMint = getUsdcMint();

  // Get mint info for decimals
  const mintInfo = await getMint(connection, usdcMint);
  const decimals = mintInfo.decimals; // 6 for USDC

  const rawAmount = Math.round(parseFloat(amount) * Math.pow(10, decimals));
  if (rawAmount <= 0) throw new Error(`sendUsdc: invalid amount '${amount}'`);

  // Get or create associated token accounts
  const fromAta = await getOrCreateAssociatedTokenAccount(
    connection, keypair, usdcMint, keypair.publicKey,
  );
  const toAta = await getOrCreateAssociatedTokenAccount(
    connection, keypair, usdcMint, destPubkey,
  );

  const tx = new Transaction().add(
    createTransferInstruction(fromAta.address, toAta.address, keypair.publicKey, rawAmount),
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
  bizEvent('treasury.usdc_sent', { destination, amount, sig });
  return sig;
}

module.exports = { sendSol, sendUsdc };
