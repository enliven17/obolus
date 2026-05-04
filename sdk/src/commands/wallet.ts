// `obolus wallet address` / `obolus wallet balance` — read-only
// helpers that wrap the OWS SDK so agents don't have to spawn Node
// one-liners to find out their own Solana address or check whether
// funding has landed.

import { loadObolusConfig } from '../config';
import { getOWSPublicKey, getOWSBalance, addUsdcToken AccountOWS } from '../ows';

function usage(): void {
  process.stderr
    .write(`Usage: obolus wallet <subcommand> [--vault-path <path>] [--name <walletname>] [--passphrase-env <ENVNAME>]

Subcommands:
  address              Print the Solana address for this agent's wallet
  balance              Print the wallet's SOL and USDC balances from Solana RPC
  token account            Open a USDC token account on this wallet's Solana account.
                       Required before the wallet can receive USDC from the
                       operator. Costs ~0.0000100 SOL in network fees and
                       raises the account's min reserve by 0.5 SOL.
  -h, --help           Show this message

Standard onboarding flow:
  1. obolus onboard --claim <code>
  2. Operator sends at least 2 SOL to the wallet's Solana address
  3. obolus wallet token account    (opens the USDC token account)
  4. Operator sends USDC
  5. obolus purchase --amount <USD>

Both subcommands read ~/.obolus/config.json for the wallet name and
vault path so you don't need to pass anything after 'obolus onboard'.
Override either with --name=<walletname> / --vault-path=<path>.
`);
}

function parseFlag(rest: string[], short: string): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;
    if (arg === short) return rest[i + 1];
    if (arg.startsWith(`${short}=`)) return arg.slice(short.length + 1);
  }
  return undefined;
}

export async function walletCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    usage();
    return sub ? 0 : 2;
  }

  const config = loadObolusConfig();
  if (!config) {
    process.stderr.write(
      "error: no obolus config found. Run 'obolus onboard --claim <code>' first.\n",
    );
    return 1;
  }

  // Resolve wallet name. Onboard writes a unique wallet_name per claim
  // to prevent cross-agent collision; a static fallback here would
  // reintroduce that bug (see onboard.ts:deriveDefaultWalletName). If
  // neither config nor --name provides one, refuse to guess.
  const walletName = parseFlag(rest, '--name') || config.wallet_name;
  if (!walletName) {
    process.stderr.write(
      'error: no wallet_name in ~/.obolus/config.json and no --name passed.\n' +
        "Either pass --name <walletname>, or re-run 'obolus onboard --claim <code>'\n" +
        'to write a fresh config with a unique wallet name.\n',
    );
    return 1;
  }
  // F12: vault_path and passphrase_env come from config first, CLI
  // flag overrides. The passphrase value is read from process.env at
  // call time; only the env var NAME is ever stored in config.
  const vaultPath = parseFlag(rest, '--vault-path') || config.vault_path;
  // F1-wallet (2026-04-16): resolve passphrase for the token account
  // subcommand. Pre-fix, addUsdcToken AccountOWS was called without a
  // passphrase — so agents onboarded with --passphrase-env couldn't
  // open a USDC token account via the CLI (the OWS vault couldn't decrypt
  // the signing key and threw a cryptic error). The purchase command
  // and the MCP setup_wallet tool both correctly pass the passphrase;
  // wallet.ts was the only caller that missed it.
  const passphraseEnv = parseFlag(rest, '--passphrase-env') || config.passphrase_env;
  const passphrase = passphraseEnv ? process.env[passphraseEnv] : undefined;

  if (sub === 'address') {
    try {
      const publicKey = getOWSPublicKey(walletName, vaultPath);
      process.stdout.write(`${publicKey}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(
        `error: wallet "${walletName}" not found: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return 1;
    }
  }

  if (sub === 'balance') {
    try {
      const publicKey = getOWSPublicKey(walletName, vaultPath);
      const bal = await getOWSBalance(walletName, vaultPath);
      process.stdout.write(`address: ${publicKey}\n`);
      process.stdout.write(`sol:     ${bal.sol}\n`);
      process.stdout.write(`usdc:    ${bal.usdc}\n`);
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Solana RPC 404 on a brand-new unactivated wallet — show zeros.
      if (msg.includes('Not Found') || msg.includes('404')) {
        try {
          const publicKey = getOWSPublicKey(walletName, vaultPath);
          process.stdout.write(`address: ${publicKey}\n`);
          // Send at least 2 SOL — 1 for the Solana base reserve plus
          // 1 for a future USDC token account entry. Matches the onboard
          // command's funding instructions, the MCP setup_wallet tool,
          // and the quickstart docs on obolus.xyz.
          process.stdout.write(`sol:     0 (unactivated — send at least 2 SOL to activate)\n`);
          process.stdout.write(`usdc:    0\n`);
          return 0;
        } catch {
          /* fall through to error */
        }
      }
      process.stderr.write(`error: ${msg}\n`);
      return 1;
    }
  }

  if (sub === 'token account') {
    // `obolus wallet token account` — opens a USDC token account on the
    // agent's Solana account. The operator's typical onboarding flow
    // is: fund with SOL → agent runs this → operator sends USDC →
    // agent runs `purchase`. Without the token account, any USDC payment
    // sent to the agent address bounces — USDC is an issued asset on
    // Solana and every holder account must authorise the issuer
    // before it can hold the balance.
    //
    // The token account operation costs one base fee (~0.00001 SOL) and
    // bumps the account's minimum reserve by 0.5 SOL, so the wallet
    // needs ~2 SOL already landed for this to succeed. We let the
    // underlying op surface the real Solana error on insufficient
    // balance rather than pre-checking — the error message is more
    // useful than a synthetic one.
    try {
      const publicKey = getOWSPublicKey(walletName, vaultPath);
      process.stdout.write(`→ Opening USDC token account for ${publicKey}…\n`);
      const txHash = await addUsdcToken AccountOWS({ walletName, passphrase, vaultPath });
      if (txHash === null) {
        process.stdout.write(`✓ USDC token account already exists on this wallet — nothing to do.\n`);
        return 0;
      }
      process.stdout.write(`✓ USDC token account opened (txid: ${txHash})\n`);
      process.stdout.write(
        `\nThe wallet can now receive USDC from your operator. Run 'obolus wallet balance'\n` +
          `to confirm the USDC line appears (shown as '0.0000000' when open and empty).\n`,
      );
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Detect the most common "why did this fail" cases and turn
      // them into actionable messages instead of the bare Solana RPC
      // response body.
      if (/not found/i.test(msg) || /404/.test(msg)) {
        process.stderr.write(
          `error: wallet is not activated on mainnet yet. Ask your operator to send\n` +
            `at least 2 SOL to the address printed by 'obolus wallet address',\n` +
            `then re-run 'obolus wallet token account'.\n`,
        );
        return 1;
      }
      if (/already exists/i.test(msg) || /op_already_exists/.test(msg)) {
        process.stdout.write(`✓ USDC token account already exists on this wallet — nothing to do.\n`);
        return 0;
      }
      if (/insufficient/i.test(msg) || /op_low_reserve/.test(msg)) {
        process.stderr.write(
          `error: insufficient SOL to open the token account. A token account subentry\n` +
            `requires +0.5 SOL of account reserve on top of the 1 SOL base. Ask\n` +
            `your operator to top up the wallet with at least 2 SOL total.\n`,
        );
        return 1;
      }
      process.stderr.write(`error: ${msg}\n`);
      return 1;
    }
  }

  process.stderr.write(`error: unknown wallet subcommand '${sub}'\n`);
  usage();
  return 2;
}
