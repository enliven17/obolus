// MCP server entry. Exposed via `obolus` or `obolus mcp` and
// dispatched through ./cli. Not intended to be imported as a module
// from anywhere else — the top-level Server setup registers handlers
// eagerly so any import runs the full initialisation path.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createOWSWallet,
  getOWSPublicKey,
  getOWSBalance,
  addUsdcToken AccountOWS,
  purchaseCardOWS,
} from './ows';
import { ObolusClient } from './client';
// Audit A-38: version string imported from package.json instead of hardcoded.
// The `with { type: 'json' }` import lets tsc emit a real assertion and
// bun/node24 load it as JSON.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PKG_VERSION = require('../package.json').version as string;

const API_KEY = process.env.OBOLUS_API_KEY ?? '';
const BASE_URL = process.env.OBOLUS_BASE_URL ?? 'https://api.obolus.xyz/v1';
const OWS_WALLET_NAME = process.env.OWS_WALLET_NAME ?? '';
const OWS_WALLET_PASSPHRASE = process.env.OWS_WALLET_PASSPHRASE ?? undefined;
const OWS_VAULT_PATH = process.env.OWS_VAULT_PATH ?? undefined;

if (!API_KEY) {
  process.stderr.write('Warning: OBOLUS_API_KEY is not set. Get one at https://obolus.xyz\n');
}

if (!OWS_WALLET_NAME) {
  process.stderr.write('Warning: OWS_WALLET_NAME is not set. Run setup_wallet for instructions.\n');
}

const server = new Server(
  { name: 'obolus', version: PKG_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'purchase_vcc',
      description:
        'Purchase a prepaid Visa virtual card. Pay with USDC or SOL on Solana. Returns card number, CVV, and expiry. Requires OWS_WALLET_NAME — run setup_wallet to configure. Minimum $0.01, maximum $10,000 per card.',
      inputSchema: {
        type: 'object',
        properties: {
          amount_usdc: {
            type: 'string',
            // Matches backend/src/api/orders.js — positive decimal string
            // between 0.01 and 10000 inclusive.
            pattern: '^\\d+(\\.\\d{1,2})?$',
            description:
              "Card value in USD as a decimal string, e.g. '10.00'. Minimum '0.01', maximum '10000.00'.",
          },
          payment_asset: {
            type: 'string',
            enum: ['auto', 'usdc', 'sol'],
            description:
              "Payment asset: 'auto' (default — picks USDC if the wallet has enough, else SOL), 'usdc', or 'sol'.",
          },
        },
        required: ['amount_usdc'],
      },
    },
    {
      name: 'setup_wallet',
      description:
        'Set up or inspect the OWS encrypted wallet used to pay obolus. Creates the wallet on first run. Shows public key and balances.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'check_order',
      description: 'Check the status of a obolus order',
      inputSchema: {
        type: 'object',
        properties: {
          order_id: {
            type: 'string',
            description: 'The obolus order ID',
          },
        },
        required: ['order_id'],
      },
    },
    {
      name: 'check_budget',
      description:
        "Check this agent's spend summary — how much has been spent, the configured limit, and how much budget remains. Use this to report spending to your owner or to decide whether you can afford a card.",
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'setup_wallet') {
    if (!OWS_WALLET_NAME) {
      return {
        content: [
          {
            type: 'text',
            text: [
              'OWS_WALLET_NAME is not set.',
              '',
              'To configure your wallet:',
              '  1. Set OWS_WALLET_NAME=<name> in your MCP server environment',
              '  2. Optionally set OWS_WALLET_PASSPHRASE=<passphrase> for extra encryption',
              '  3. Optionally set OWS_VAULT_PATH=<path> to store the vault file at a custom location',
              '  4. Run setup_wallet to create the wallet and get your public key',
              '',
              'Also set OBOLUS_API_KEY=<your key> (get one at obolus.xyz)',
            ].join('\n'),
          },
        ],
      };
    }

    try {
      let publicKey: string;
      let created = false;
      try {
        publicKey = getOWSPublicKey(OWS_WALLET_NAME, OWS_VAULT_PATH);
      } catch {
        const result = createOWSWallet(OWS_WALLET_NAME, OWS_WALLET_PASSPHRASE, OWS_VAULT_PATH);
        publicKey = result.publicKey;
        created = true;
      }

      const lines: string[] = [
        created ? 'OWS Wallet Created' : 'OWS Wallet',
        '',
        `Wallet name: ${OWS_WALLET_NAME}`,
        `Public key:  ${publicKey}`,
      ];

      let accountStatus = 'unknown';
      try {
        const bal = await getOWSBalance(OWS_WALLET_NAME, OWS_VAULT_PATH);
        const xlmNum = parseFloat(bal.sol);
        const usdcNum = parseFloat(bal.usdc);

        if (xlmNum >= 2 && usdcNum === 0) {
          // Wallet is funded but no USDC token account yet — add it automatically
          lines.push('');
          lines.push('USDC token account: adding…');
          try {
            const txHash = await addUsdcToken AccountOWS({
              walletName: OWS_WALLET_NAME,
              passphrase: OWS_WALLET_PASSPHRASE,
              vaultPath: OWS_VAULT_PATH,
            });
            if (txHash === null) {
              lines.push(`USDC token account: already exists`);
            } else {
              lines.push(`USDC token account: added (txid: ${txHash})`);
            }
            accountStatus = 'ready_no_usdc';
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            lines.push(`USDC token account: could not add (${errMsg.slice(0, 120)})`);
            lines.push(
              '  This may mean the token account already exists, or SOL balance is too low for fees.',
            );
            accountStatus = usdcNum > 0 ? 'ready' : 'funded_no_token account';
          }
          // Re-fetch balance after token account op
          try {
            const bal2 = await getOWSBalance(OWS_WALLET_NAME, OWS_VAULT_PATH);
            lines.push('');
            lines.push(`SOL balance:  ${bal2.sol}`);
            lines.push(`USDC balance: ${bal2.usdc}`);
            lines.push('');
            lines.push('Status: Wallet ready. Fund with USDC to purchase cards with USDC,');
            lines.push('        or top up SOL to purchase with native SOL (no USDC needed).');
          } catch {
            lines.push('');
            lines.push(`SOL balance:  ${bal.sol}`);
            lines.push(`USDC balance: ${bal.usdc}`);
          }
        } else if (xlmNum >= 2 && usdcNum > 0) {
          accountStatus = 'ready';
          lines.push('');
          lines.push(`SOL balance:  ${bal.sol}`);
          lines.push(`USDC balance: ${bal.usdc}`);
          lines.push('');
          lines.push('Status: Ready to purchase cards.');
        } else if (xlmNum > 0 && xlmNum < 2) {
          accountStatus = 'low_xlm';
          lines.push('');
          lines.push(`SOL balance:  ${bal.sol}`);
          lines.push(`USDC balance: ${bal.usdc}`);
          lines.push('');
          lines.push('Status: Account active but SOL balance is low.');
          lines.push('        Send at least 2 SOL total to cover reserves and fees.');
        } else {
          accountStatus = 'unfunded';
          lines.push('');
          lines.push(`SOL balance:  ${bal.sol}`);
          lines.push(`USDC balance: ${bal.usdc}`);
          lines.push('');
          lines.push('Status: Account not yet funded. Send at least 2 SOL to activate.');
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (
          errMsg.includes('404') ||
          errMsg.toLowerCase().includes('not found') ||
          errMsg.includes('request failed')
        ) {
          // Account does not exist on-chain yet (not activated)
          accountStatus = 'not_activated';
          lines.push('');
          lines.push('Status: Account not activated (no on-chain balance).');
        } else {
          // Network error or Solana RPC outage — don't guess account state
          lines.push('');
          lines.push(`Status: Could not fetch balance (${errMsg.slice(0, 120)})`);
          lines.push('Check your network connection and try again.');
        }
      }

      lines.push('');
      lines.push('Environment variables:');
      lines.push(`  OWS_WALLET_NAME       — wallet identifier (set: "${OWS_WALLET_NAME}")`);
      lines.push(
        `  OWS_WALLET_PASSPHRASE — encryption passphrase (${OWS_WALLET_PASSPHRASE ? 'set' : 'not set'})`,
      );
      lines.push(
        `  OWS_VAULT_PATH        — vault file path (${OWS_VAULT_PATH ?? 'default: ~/.ows/wallets/'})`,
      );
      lines.push('  OBOLUS_API_KEY      — your obolus API key');

      if (accountStatus === 'not_activated' || accountStatus === 'unfunded') {
        lines.push('');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('ACTION REQUIRED — copy this block and send it to your human operator');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('');
        lines.push('Your AI agent has a Solana wallet that needs funding before it can');
        lines.push('purchase cards. Please send SOL (and optionally USDC) to the');
        lines.push('address below.');
        lines.push('');
        lines.push(`  Wallet address:  ${publicKey}`);
        lines.push('  (copy the G... address exactly — it is case-sensitive)');
        lines.push('');
        lines.push('  How much to send:');
        lines.push('    • At least 2 SOL to activate the account and cover reserves.');
        lines.push('    • For SOL-funded purchases: enough SOL to cover the card');
        lines.push('      face value at the current SOL/USD rate. The exact amount');
        lines.push('      is quoted when the order is created; top up with a safety');
        lines.push('      margin because the rate moves.');
        lines.push('    • For USDC-funded purchases: 2 SOL + the USDC face value.');
        lines.push('      The SDK adds the USDC token account on the first purchase.');
        lines.push('');
        lines.push('  Where to get SOL / USDC:');
        lines.push('    Coinbase: coinbase.com → Buy SOL or USDC → Send → paste address');
        lines.push('    Lobstr:   lobstr.co → Buy SOL or USDC → Send → paste address');
        lines.push('    Kraken:   kraken.com → Buy → Withdraw (Solana) → paste address');
        lines.push('');
        lines.push('  After sending: tell your agent to run setup_wallet again to confirm.');
        lines.push('──────────────────────────────────────────────────────────────────');
      } else if (accountStatus === 'low_xlm') {
        lines.push('');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('ACTION REQUIRED — wallet needs more SOL');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('');
        lines.push(`  Wallet address:  ${publicKey}`);
        lines.push('');
        lines.push('  Send more SOL to cover the Solana account reserve, a USDC');
        lines.push('  token account entry, and transaction fees — at least 2 SOL total.');
        lines.push('  For SOL-funded purchases, also send enough SOL to cover the');
        lines.push('  card face value at the current SOL/USD rate (topped up with a');
        lines.push('  safety margin because the rate moves).');
        lines.push('──────────────────────────────────────────────────────────────────');
      } else if (accountStatus === 'ready_no_usdc') {
        lines.push('');
        lines.push('Next steps:');
        lines.push(`  Wallet address: ${publicKey}`);
        lines.push('');
        lines.push('  To pay with SOL (recommended):');
        lines.push('    Send more SOL to the address above, then call:');
        lines.push('    purchase_vcc { amount_usdc: "10.00", payment_asset: "sol" }');
        lines.push('');
        lines.push('  To pay with USDC:');
        lines.push('    Send USDC to the address above (token account is already set up), then call:');
        lines.push('    purchase_vcc { amount_usdc: "10.00", payment_asset: "usdc" }');
      } else if (accountStatus === 'funded_no_token account') {
        // Wallet has enough SOL but the USDC token account add attempt failed
        // (usually because the wallet SOL balance dropped below 2 just as
        // we tried, or Solana RPC flaked). Agents can retry or pay in SOL.
        lines.push('');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('USDC token account could not be added automatically');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('');
        lines.push(`  Wallet address: ${publicKey}`);
        lines.push('');
        lines.push('  Options:');
        lines.push('    1. Run setup_wallet again — the retry often succeeds.');
        lines.push('    2. Top up the wallet with a bit more SOL (you need 2 SOL');
        lines.push('       minimum: 1 for the account reserve + 1 for the token account');
        lines.push('       entry + fees).');
        lines.push('    3. Pay with SOL instead of USDC — no token account required:');
        lines.push('       purchase_vcc { amount_usdc: "10.00", payment_asset: "sol" }');
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error in setup_wallet: ${message}` }],
        isError: true,
      };
    }
  }

  if (!API_KEY) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: OBOLUS_API_KEY environment variable is not set. Get your API key at https://obolus.xyz',
        },
      ],
      isError: true,
    };
  }

  if (name === 'purchase_vcc') {
    if (!OWS_WALLET_NAME) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: OWS_WALLET_NAME is not set. Run setup_wallet for configuration instructions.',
          },
        ],
        isError: true,
      };
    }

    // Validate and extract args explicitly — never trust MCP client types
    const rawArgs = args as Record<string, unknown>;
    const amount_usdc = String(rawArgs.amount_usdc ?? '').trim();
    const raw_asset = String(rawArgs.payment_asset ?? 'auto').toLowerCase();

    // Amount validation — mirrors backend/src/api/orders.js bounds so the
    // agent gets a specific error here instead of a generic 400 from the
    // backend. Min $0.01, max $10,000, decimal string, ≤2 decimal places.
    if (!/^\d+(\.\d{1,2})?$/.test(amount_usdc)) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: amount_usdc must be a decimal string, e.g. "10.00" or "25.5"',
          },
        ],
        isError: true,
      };
    }
    const amountNum = parseFloat(amount_usdc);
    if (amountNum < 0.01) {
      return {
        content: [{ type: 'text', text: 'Error: amount_usdc must be at least 0.01 (one US cent)' }],
        isError: true,
      };
    }
    if (amountNum > 10000) {
      return {
        content: [
          {
            type: 'text',
            text: "Error: amount_usdc cannot exceed 10000.00 (Pathward's per-card balance ceiling). For larger aggregate spend, issue multiple cards.",
          },
        ],
        isError: true,
      };
    }

    if (raw_asset !== 'usdc' && raw_asset !== 'sol' && raw_asset !== 'auto') {
      return {
        content: [{ type: 'text', text: 'Error: payment_asset must be "auto", "usdc", or "sol"' }],
        isError: true,
      };
    }

    // Pre-purchase balance check. Also resolves payment_asset when the
    // caller asked for 'auto': pick USDC if the wallet holds enough,
    // else fall back to SOL. Matches the CLI's `purchase --asset auto`
    // behaviour at sdk/src/commands/purchase.ts:184 so agents see the
    // same resolution logic regardless of which surface they use.
    let payment_asset: 'usdc' | 'sol';
    const autoPickNotes: string[] = [];

    try {
      const balance = await getOWSBalance(OWS_WALLET_NAME, OWS_VAULT_PATH);
      const publicKey = getOWSPublicKey(OWS_WALLET_NAME, OWS_VAULT_PATH);
      const xlmNum = parseFloat(balance.sol);
      const usdcNum = parseFloat(balance.usdc);

      if (raw_asset === 'auto') {
        if (usdcNum >= amountNum && amountNum > 0) {
          payment_asset = 'usdc';
          autoPickNotes.push(
            `Auto-picked USDC (wallet has ${usdcNum.toFixed(2)} USDC; covers $${amount_usdc}).`,
          );
        } else {
          payment_asset = 'sol';
          autoPickNotes.push(
            usdcNum > 0
              ? `Auto-picked SOL (wallet has only ${usdcNum.toFixed(2)} USDC; needs $${amount_usdc}).`
              : 'Auto-picked SOL (no USDC in wallet).',
          );
        }
      } else {
        payment_asset = raw_asset as 'usdc' | 'sol';
      }

      if (payment_asset === 'usdc') {
        if (usdcNum < amountNum) {
          const shortfall = (amountNum - usdcNum).toFixed(2);
          return {
            content: [
              {
                type: 'text',
                text: [
                  'Insufficient USDC balance.',
                  '',
                  `  You have:    ${balance.usdc} USDC`,
                  `  You need:    ${amount_usdc} USDC`,
                  `  Shortfall:   ${shortfall} USDC`,
                  '',
                  `Send USDC to your wallet address:`,
                  `  ${publicKey}`,
                  '',
                  'After funding, run purchase_vcc again.',
                  'Or switch to SOL payment: purchase_vcc { payment_asset: "sol" }',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }
      } else {
        // SOL: we don't know the exact rate until the order is created, but
        // we can gate on a hard floor of 3 SOL (~1.5 SOL for reserves + a
        // token account entry + comfortable headroom for fees) to catch
        // obviously-unfunded wallets before hitting the API.
        if (xlmNum < 3) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  'SOL balance is too low to purchase a card.',
                  '',
                  `  You have:  ${balance.sol} SOL`,
                  `  Minimum:   3 SOL (Solana base reserve + token account + fee headroom)`,
                  '',
                  'The exact SOL amount for this order is quoted by the backend',
                  'when the order is created. Top up with extra for safety.',
                  '',
                  `Send SOL to your wallet address:`,
                  `  ${publicKey}`,
                  '',
                  'Where to get SOL:',
                  '  Coinbase:  coinbase.com → Buy SOL → Send',
                  '  Lobstr:    lobstr.co → Buy SOL → Send',
                  '',
                  'After funding, run purchase_vcc again.',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }
      }
    } catch {
      // Could not fetch balance (wallet not activated, Solana RPC outage, etc.).
      // Fall through to the purchase call with a sensible default — SOL, since
      // it doesn't need a token account so it has the lowest chance of an
      // immediate error. The real error will surface out of purchaseCardOWS.
      payment_asset = raw_asset === 'auto' ? 'sol' : (raw_asset as 'usdc' | 'sol');
      if (raw_asset === 'auto') {
        autoPickNotes.push(
          'Could not read wallet balance — auto-picked SOL as the no-token account-required fallback.',
        );
      }
    }

    try {
      const card = await purchaseCardOWS({
        apiKey: API_KEY,
        walletName: OWS_WALLET_NAME,
        amountUsdc: amount_usdc,
        paymentAsset: payment_asset,
        passphrase: OWS_WALLET_PASSPHRASE,
        vaultPath: OWS_VAULT_PATH,
        baseUrl: BASE_URL,
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              'Virtual Visa Card Ready',
              ...(autoPickNotes.length ? ['', ...autoPickNotes] : []),
              '',
              `Number: ${card.number}`,
              `CVV:    ${card.cvv}`,
              `Expiry: ${card.expiry}`,
              `Brand:  ${card.brand ?? 'Visa'}`,
              '',
              `Order ID: ${card.order_id}`,
              '',
              'This is a one-time use virtual card. Keep these details safe.',
            ].join('\n'),
          },
        ],
      };
    } catch (err) {
      // Only expose typed API errors — other errors may contain internal details
      const message =
        err instanceof Error && err.constructor.name.endsWith('Error') && 'status' in err
          ? err.message
          : err instanceof Error
            ? err.message.slice(0, 200)
            : 'Purchase failed';
      return {
        content: [{ type: 'text', text: `Error purchasing card: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'check_order') {
    // Validate order_id before using it in a URL path
    const rawOrderId = String((args as Record<string, unknown>).order_id ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rawOrderId)) {
      return {
        content: [{ type: 'text', text: 'Error: invalid order ID format' }],
        isError: true,
      };
    }
    const order_id = rawOrderId;

    try {
      const client = new ObolusClient({ apiKey: API_KEY, baseUrl: BASE_URL });
      const order = await client.getOrder(order_id);

      const lines = [
        `Order: ${order.order_id}`,
        `Status: ${order.status} (phase: ${order.phase})`,
        `Amount: $${order.amount_usdc} USDC`,
        `Asset: ${order.payment_asset}`,
        `Created: ${order.created_at}`,
        `Updated: ${order.updated_at}`,
      ];
      if (order.phase === 'ready' && order.card) {
        lines.push('');
        lines.push('Card details:');
        lines.push(`  Number: ${order.card.number}`);
        lines.push(`  CVV:    ${order.card.cvv}`);
        lines.push(`  Expiry: ${order.card.expiry}`);
        lines.push(`  Brand:  ${order.card.brand ?? 'Visa'}`);
      }
      if (order.error) {
        lines.push('');
        lines.push(`Error: ${order.error}`);
      }
      if (order.refund) {
        lines.push(`Refund txid: ${order.refund.solana_txid}`);
      }
      if (order.note) {
        lines.push(`Note: ${order.note}`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (err) {
      // Match purchase_vcc's sanitization: typed API errors through,
      // everything else truncated so we don't leak stack frames or
      // internal URLs into the MCP transcript.
      const message =
        err instanceof Error && err.constructor.name.endsWith('Error') && 'status' in err
          ? err.message
          : err instanceof Error
            ? err.message.slice(0, 200)
            : 'Check order failed';
      return {
        content: [{ type: 'text', text: `Error checking order: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'check_budget') {
    try {
      const client = new ObolusClient({ apiKey: API_KEY, baseUrl: BASE_URL });
      const usage = await client.getUsage();
      const { budget, orders, label } = usage;
      const lines = [
        `Budget summary${label ? ` for "${label}"` : ''}`,
        '',
        `Spent:     $${budget.spent_usdc} USDC`,
        budget.limit_usdc ? `Limit:     $${budget.limit_usdc} USDC` : 'Limit:     unlimited',
        budget.remaining_usdc !== null
          ? `Remaining: $${budget.remaining_usdc} USDC`
          : 'Remaining: unlimited',
        '',
        `Orders — total: ${orders.total}, delivered: ${orders.delivered}, failed: ${orders.failed}, refunded: ${orders.refunded}, in progress: ${orders.in_progress}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      const message =
        err instanceof Error && err.constructor.name.endsWith('Error') && 'status' in err
          ? err.message
          : err instanceof Error
            ? err.message.slice(0, 200)
            : 'Check budget failed';
      return {
        content: [{ type: 'text', text: `Error checking budget: ${message}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
