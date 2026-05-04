# obolus

Virtual Visa cards for AI agents — pay with USDC or SOL on Solana, get a card number, CVV, and expiry in ~60 seconds.

[obolus.xyz](https://obolus.xyz) issues prepaid Visa virtual cards on demand. This SDK lets AI agents create an order, pay the obolus Solana receiver contract on Solana, and receive card details programmatically — all in one call.

## Install

```bash
npm install obolus
```

Requires Node.js 18 or newer (the SDK uses native `fetch`, `ReadableStream`, and `WebCrypto`). Supported platforms via the bundled `@obolus/solana-ows-core` native wallet bindings: macOS (arm64 + x64), Linux (arm64 + x64). Windows is not currently supported.

### A note on `npm audit`

You'll see 3 critical advisories on `axios <= 1.14.0` after installing. They come from `@solana/web3.js`, which hard-pins an older axios version that we can't override from inside this package. The SDK's own HTTP calls only talk to hardcoded Solana RPC / Solana RPC endpoints, so neither advisory (NO_PROXY SSRF, header-injection metadata exfil) is reachable through obolus code — it's noise for our use, but noise you should still silence at your own project root.

Fix in your own `package.json`:

```json
{
  "overrides": {
    "axios": "^1.15.0"
  }
}
```

then `rm -rf node_modules package-lock.json && npm install`. `npm audit` returns clean. Upstream fix tracked at [solana/js-solana-web3.js#1381](https://github.com/solana/js-solana-web3.js/pull/1381); this note will be removed as soon as it merges and a new solana-web3.js ships.

## Quick start

```typescript
import { createOWSWallet, getOWSBalance, purchaseCardOWS } from 'obolus';

// 1. Create (or fetch existing) encrypted wallet. Idempotent.
const { publicKey } = createOWSWallet('my-agent');
console.log('Fund this Solana address:', publicKey);

// 2. Pause here until the address has funds. Re-run to check:
const bal = await getOWSBalance('my-agent');
console.log(`SOL: ${bal.sol}  USDC: ${bal.usdc}`);

// 3. Purchase a card — only do this when the user explicitly asks.
const card = await purchaseCardOWS({
  apiKey: process.env.OBOLUS_API_KEY!,
  walletName: 'my-agent',
  amountUsdc: '10.00',
  paymentAsset: 'sol', // or 'usdc' (token account added automatically)
});

console.log(card.number, card.cvv, card.expiry);
```

`purchaseCardOWS` handles the whole flow:

1. `POST /v1/orders` with the amount
2. Sign + submit the Solana payment from your OWS wallet
3. Subscribe to the SSE stream at `/v1/orders/:id/stream`
4. Return the card details as soon as the `ready` event arrives

No polling loops, no webhook endpoint required.

## Funding your wallet

Solana accounts need a minimum balance to be activated on-chain:

- **Pay with SOL:** send ≥ 1 SOL to cover the base reserve, plus whatever SOL the card costs at the current spot rate (shown in `payment.sol.amount` when you create an order).
- **Pay with USDC:** send ≥ 2 SOL (1 base reserve + 1 for the USDC token account entry), plus the USDC card amount. The SDK will add the token account automatically the first time you purchase with USDC, so you just need the ≥ 2 SOL on-chain before calling `purchaseCardOWS`.

## Step-by-step API (for more control)

```typescript
import { ObolusClient } from 'obolus';

const client = new ObolusClient({
  apiKey: process.env.OBOLUS_API_KEY!,
  // baseUrl defaults to https://api.obolus.xyz/v1
});

// Create the order
const order = await client.createOrder({ amount_usdc: '10.00' });
console.log(`Pay ${order.payment.sol.amount} SOL to contract ${order.payment.contract_id}`);

// ... submit the Solana transaction yourself, or use the payViaContract helpers ...

// Wait for delivery (uses SSE under the hood, with polling fallback)
const card = await client.waitForCard(order.order_id, { timeoutMs: 120000 });
console.log(card.number, card.cvv, card.expiry);
```

## MCP server — for Claude Desktop, Cursor, and other MCP clients

Add to your client's `mcpServers` config:

```json
{
  "mcpServers": {
    "obolus": {
      "command": "npx",
      "args": ["-y", "obolus"],
      "env": { "OBOLUS_API_KEY": "obolus_<your key>" }
    }
  }
}
```

The MCP server exposes four tools: `setup_wallet`, `check_budget`, `check_order`, and `purchase_vcc`.

## Error handling

All SDK errors inherit from `ObolusError`. Typed subclasses let you react to specific failure modes:

```typescript
import {
  ObolusError,
  AuthError,
  SpendLimitError,
  RateLimitError,
  ServiceUnavailableError,
  InvalidAmountError,
  OrderFailedError,
  WaitTimeoutError,
} from 'obolus';

try {
  const card = await purchaseCardOWS({ ... });
} catch (err) {
  if (err instanceof SpendLimitError) { /* cap reached — ask owner to raise */ }
  else if (err instanceof OrderFailedError) { /* check err.refund for refund tx */ }
  else if (err instanceof WaitTimeoutError) { /* network flake or stalled fulfillment */ }
  else if (err instanceof AuthError) { /* bad key */ }
}
```

## Keeping card details safe

`purchaseCardOWS` returns the card PAN, CVV, and expiry as plain strings. **Treat them as secrets.** Don't log them, don't write them to disk, don't send them to observability pipelines unless those pipelines are explicitly PCI-compliant.

## Links

- [obolus.xyz](https://obolus.xyz) — dashboard and docs
- [obolus.xyz/docs](https://obolus.xyz/docs) — full API reference
- [obolus.xyz/skill.md](https://obolus.xyz/skill.md) — drop-in agent onboarding brief
- [obolus.xyz/llms.txt](https://obolus.xyz/llms.txt) — LLM-index of every docs surface
- [github.com/enliven/obolus](https://github.com/enliven/obolus) — source

## License

MIT — see [LICENSE](./LICENSE).
