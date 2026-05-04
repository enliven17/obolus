# Buy VCC

Purchase a prepaid Visa virtual card via obolus.xyz.

## Usage

/buy-vcc [amount]

## Instructions

When invoked:

1. Check if `OBOLUS_API_KEY` and `OWS_WALLET_NAME` are set. If not, explain:
   - `OBOLUS_API_KEY` — get one at obolus.xyz
   - `OWS_WALLET_NAME` — the OWS wallet identifier; run `setup_wallet` (MCP) or:
     ```typescript
     import { createOWSWallet } from 'obolus';
     const { publicKey } = createOWSWallet(process.env.OWS_WALLET_NAME!);
     // Fund publicKey with SOL and USDC, then come back
     ```

2. Ask what amount they want (default $10 if not specified) and whether to pay with USDC or SOL.

3. Before purchasing, check the budget:

   ```typescript
   import { ObolusClient } from 'obolus';
   const client = new ObolusClient({ apiKey: process.env.OBOLUS_API_KEY! });
   const usage = await client.getUsage();
   ```

   If `usage.budget.remaining_usdc` is not null and the amount exceeds it, tell the user and stop. Show the current budget.

4. Purchase the card:

   ```typescript
   import { purchaseCardOWS } from 'obolus';

   const card = await purchaseCardOWS({
     apiKey: process.env.OBOLUS_API_KEY!,
     walletName: process.env.OWS_WALLET_NAME!,
     passphrase: process.env.OWS_WALLET_PASSPHRASE,
     vaultPath: process.env.OWS_VAULT_PATH,
     amountUsdc: '10.00', // or whatever the user requested
     paymentAsset: 'usdc', // or 'sol'
   });
   ```

5. Display the card details:

   ```
   ✅ Virtual Visa Card Ready

   Number: XXXX XXXX XXXX XXXX
   CVV:    XXX
   Expiry: XX/XX
   Brand:  Visa

   Order: <order_id>
   ```

6. Report the updated spend summary:

   ```typescript
   const usage = await client.getUsage();
   ```

   ```
   💳 Spend update for <label>:
   $<spent> spent of $<limit> limit — $<remaining> remaining
   Orders: <delivered> delivered, <failed> failed
   ```

   If there is no limit, say "no limit set".

7. Remind the user this is a one-time use virtual card.

## Environment variables needed

- `OBOLUS_API_KEY` — your obolus API key (get one at obolus.xyz)
- `OWS_WALLET_NAME` — OWS wallet identifier (must be funded with USDC or SOL)
- `OWS_WALLET_PASSPHRASE` — wallet encryption passphrase (optional)
- `OWS_VAULT_PATH` — vault file path (optional, default: `~/.ows/vault`)
