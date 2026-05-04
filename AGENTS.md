# Obolus Agent Guide

## Quick start

```
POST /v1/orders          → create order, get Solana payment instructions
pay_usdc() or pay_sol()  → send funds to Obolus Anchor program
GET /v1/orders/:id       → poll until phase = "ready"
use card.number, card.cvv, card.expiry
```

## Auth

`X-Api-Key: obolus_...` on every request.

## Order phases

```
awaiting_payment → processing → ready
      ↓ expired        ↓ failed → refunded
```

## Contract

Program ID (devnet): `9CQph7JCyba9uWBRGoDmpiGSnZn2gtvqLBTMF7CYKJzK`
