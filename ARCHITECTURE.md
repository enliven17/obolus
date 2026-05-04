# Obolus Architecture

## Overview

Obolus is an AI agent treasury for Bags-funded projects. Creators launch on Bags,
raise community funding, and deploy an AI agent that autonomously manages their
development spending — every purchase made with a real Visa virtual card, every
transaction visible to token holders.

| Component | Directory | Role |
|---|---|---|
| **Obolus backend** | `backend/` | HTTP API, Solana event watcher, order state machine, policy engine, dashboard |
| **Obolus web** | `web/` | Next.js creator dashboard, community feed, agent chat |
| **Obolus contract** | `contract/` | Solana Anchor program — accepts USDC/SOL from agents |
| **VCC service** | `vcc/` | Mini fulfillment service — Tango Card API → real Visa cards |
| **AI Agent** | `agent/` | Claude-powered spending agent |

---

## End-to-End Payment Flow

```
Creator (Bags)          Obolus Backend         VCC Service        Tango Card
     │                       │                      │                  │
     │  Fund project          │                      │                  │
     │  (Bags token)          │                      │                  │
     │                        │                      │                  │
Agent → POST /v1/orders ──────▶                      │                  │
     │   ← contract_id +       │                      │                  │
     │     USDC/SOL quote      │                      │                  │
     │                        │                      │                  │
Agent → accept_usdc() ──────▶ Solana Program          │                  │
     │   (on-chain)            │   event emitted       │                  │
     │                        │◀── watcher detects    │                  │
     │                        │                      │                  │
     │                        │──── POST /invoice ──▶│                  │
     │                        │◀─── { job_id }       │                  │
     │                        │                      │─── order card ──▶│
     │                        │                      │◀── card details  │
     │                        │◀── HMAC callback ────│                  │
     │                        │   { card: PAN/CVV }   │                  │
     │                        │                      │                  │
Agent ← GET /v1/orders/:id ───│                      │                  │
     │   phase: "ready"        │                      │                  │
     │   card: { number... }   │                      │                  │
     │                        │                      │                  │
Agent → real purchase ─────────────────────────────────────────────────▶
     │   (Vercel, AWS, etc)
```

---

## Solana Program (`contract/`)

**Program ID (devnet):** `9CQph7JCyba9uWBRGoDmpiGSnZn2gtvqLBTMF7CYKJzK`

Two instructions:

```rust
// Agent pays USDC for a card order
pub fn accept_usdc(ctx: Context<AcceptUsdc>, order_id: [u8; 32], amount: u64) -> Result<()>

// Agent pays SOL for a card order
pub fn accept_sol(ctx: Context<AcceptSol>, order_id: [u8; 32], amount: u64) -> Result<()>
```

Both emit a `PaymentReceived` event parsed by `backend/src/payments/solana.js`.

---

## Backend (`backend/`)

Node.js + Express + SQLite. Key modules:

| File | Role |
|---|---|
| `payments/solana.js` | Polls Solana for PaymentReceived events (3s interval) |
| `payments/solana-sender.js` | Sends USDC/SOL refunds from treasury |
| `payments/sol-price.js` | SOL/USD oracle (CoinGecko, 30s cache) |
| `payment-handler.js` | Validates payment, claims order, runs VCC pipeline |
| `vcc-client.js` | HTTP client for VCC service |
| `api/orders.js` | POST/GET /v1/orders |
| `api/vcc-callback.js` | HMAC-verified callback from VCC |
| `api/dashboard.js` | Per-creator dashboard API |
| `policy.js` | Spend limits, approval gating |
| `jobs.js` | Background reconcilers |

### Order phases (agent-visible)

```
awaiting_payment → processing → ready
      ↓ expired        ↓ failed → refunded
```

---

## VCC Service (`vcc/`)

Mini Express server wrapping Tango Card API. 4 endpoints:

```
POST /api/register          → { token }
POST /api/jobs/invoice      → { job_id }  + async Tango Card order
POST /api/jobs/:id/paid     → triggers card delivery callback
GET  /api/jobs/:id          → job status
```

Callback to backend: HMAC-signed `POST /vcc-callback` with `{ card: { number, cvv, expiry } }`.

---

## AI Agent (`agent/`)

Claude-powered (Anthropic SDK). Capabilities:

- Autonomous spending decisions within policy limits
- Creator natural language interface ("spend $100 on hosting this month")
- Monthly report generation
- Service renewal detection

---

## Bags Integration

- Creator connects Bags project → platform reads token holder list
- Every card transaction → 2.5% fee → distributed to platform token holders (Bags royalty)
- Token holders see real-time spending feed with Solana tx hashes

---

## Environment Variables

See `backend/.env.example` for full list. Critical:

| Variable | Purpose |
|---|---|
| `SOLANA_TREASURY_SECRET` | Treasury wallet secret key (base58) |
| `SOLANA_PROGRAM_ID` | Deployed Anchor program ID |
| `SOLANA_USDC_MINT` | USDC mint address (devnet/mainnet) |
| `VCC_API_BASE` | VCC service URL |
| `OBOLUS_BASE_URL` | Public backend URL (VCC callback) |
| `VCC_CALLBACK_SECRET` | HMAC secret for VCC callbacks |
| `ANTHROPIC_API_KEY` | Claude API key for AI agent |
| `BAGS_API_KEY` | Bags platform API key |
