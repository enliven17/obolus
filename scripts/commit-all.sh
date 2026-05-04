#!/usr/bin/env bash
# 60 sistematik commit scripti
# Kullanım: bash scripts/commit-all.sh
set -e

commit() {
  local msg="$1"
  shift
  git add "$@"
  git diff --cached --quiet && echo "skip: $msg (no changes)" && return
  git commit -m "$msg"
  echo "✓ $msg"
}

echo "=== Obolus — 60 commit başlatılıyor ==="

# ─── Grup 1: Proje temeli ───────────────────────────────────────────────────

commit "chore: add gitignore and gitleaks security config" \
  .gitignore .gitleaks.toml

commit "chore: add prettier formatting config" \
  .prettierrc .prettierignore

commit "chore: add eslint config for TypeScript and React" \
  eslint.config.js

commit "chore: add commitlint conventional commits config" \
  commitlint.config.js

commit "chore: add husky git hooks (pre-commit, commit-msg, pre-push)" \
  .husky/

commit "chore: add tsconfig base and root workspace package.json" \
  tsconfig.base.json package.json package-lock.json

# ─── Grup 2: Solana Anchor Kontrat ─────────────────────────────────────────

commit "feat(contract): add Anchor project structure and workspace config" \
  contract/Anchor.toml contract/Cargo.toml contract/rust-toolchain.toml \
  contract/package.json contract/package-lock.json

commit "feat(contract): implement accept_usdc instruction with SPL token transfer" \
  contract/programs/obolus/Cargo.toml \
  contract/programs/obolus/src/lib.rs

commit "test(contract): add Anchor integration tests for payment instructions" \
  contract/tests/obolus.ts

# ─── Grup 3: Backend — Temel Yapı ──────────────────────────────────────────

commit "feat(backend): initialize Node.js package with dependencies" \
  backend/package.json backend/package-lock.json backend/jsconfig.json

commit "feat(backend): add env validation schema with zod (all vars typed)" \
  backend/src/env.js

commit "feat(backend): add SQLite database with 16 schema migrations" \
  backend/src/db.js

commit "feat(backend): add structured logger and business event emitter" \
  backend/src/lib/logger.js

commit "feat(backend): add process-level error handlers and formatters" \
  backend/src/lib/process-handlers.js

# ─── Grup 4: Backend — Güvenlik Kütüphaneleri ──────────────────────────────

commit "feat(backend): add AES-256-GCM secret-box for card data encryption" \
  backend/src/lib/secret-box.js

commit "feat(backend): add HMAC signature verification (v3 with per-order nonce)" \
  backend/src/lib/hmac.js

commit "feat(backend): add SSRF protection for webhook URLs" \
  backend/src/lib/ssrf.js

commit "feat(backend): add claim code hashing utility" \
  backend/src/lib/claim-hash.js

commit "feat(backend): add sanitize-error utility for safe error serialization" \
  backend/src/lib/sanitize-error.js

commit "feat(backend): add audit log recorder for dashboard actions" \
  backend/src/lib/audit.js

commit "feat(backend): add in-process event bus for SSE fanout" \
  backend/src/lib/event-bus.js

commit "feat(backend): add email OTP delivery via nodemailer" \
  backend/src/lib/email.js

commit "feat(backend): add webhook delivery log and retry helpers" \
  backend/src/lib/webhook-log.js backend/src/lib/retry.js

commit "feat(backend): add agent state management and stats helpers" \
  backend/src/lib/agent-state.js backend/src/lib/stats.js \
  backend/src/lib/db-helpers.js backend/src/lib/permissions.js \
  backend/src/lib/platform.js backend/src/lib/normalize-card.js \
  backend/src/lib/card-vault.js backend/src/lib/alerts.js \
  backend/src/lib/enabled-merchants.js

# ─── Grup 5: Backend — Auth Middleware ─────────────────────────────────────

commit "feat(backend): add API key authentication middleware (bcrypt + prefix)" \
  backend/src/middleware/auth.js

commit "feat(backend): add dashboard session and role authorization middleware" \
  backend/src/middleware/requireAuth.js \
  backend/src/middleware/requireDashboard.js \
  backend/src/middleware/requireOwner.js \
  backend/src/middleware/requirePlatformOwner.js \
  backend/src/middleware/requireInternal.js \
  backend/src/middleware/requireCardReveal.js

# ─── Grup 6: Backend — Solana Ödeme Katmanı ────────────────────────────────

commit "feat(backend): add Solana event watcher (polls devnet every 3s)" \
  backend/src/payments/solana.js

commit "feat(backend): add Solana USDC/SOL refund sender for failed orders" \
  backend/src/payments/solana-sender.js

commit "feat(backend): add SOL/USD price oracle with CoinGecko and 30s cache" \
  backend/src/payments/sol-price.js

# ─── Grup 7: Backend — Order Sistemi ───────────────────────────────────────

commit "feat(backend): add order core creation with idempotency key support" \
  backend/src/orders/core.js

commit "feat(backend): add payment handler (Solana event → VCC pipeline)" \
  backend/src/payment-handler.js

commit "feat(backend): add VCC client for card fulfillment job dispatch" \
  backend/src/vcc-client.js

commit "feat(backend): add order fulfillment state machine with circuit breaker" \
  backend/src/fulfillment.js

commit "feat(backend): add policy engine for spend limits and approval gating" \
  backend/src/policy.js

commit "feat(backend): add background jobs (reconciler, funding check, alerts)" \
  backend/src/jobs.js

# ─── Grup 8: Backend — API Endpoint'leri ───────────────────────────────────

commit "feat(backend): add POST/GET /v1/orders with rate limiting and SSE" \
  backend/src/api/orders.js

commit "feat(backend): add email OTP auth routes (/auth/login, /verify, /me)" \
  backend/src/api/auth.js

commit "feat(backend): add HMAC-verified VCC callback endpoint" \
  backend/src/api/vcc-callback.js

commit "feat(backend): add operator dashboard API (agents, orders, spend)" \
  backend/src/api/dashboard.js

commit "feat(backend): add platform cross-tenant API (treasury, health, unmatched)" \
  backend/src/api/platform.js

commit "feat(backend): add internal ops API for admin operations" \
  backend/src/api/internal.js

# ─── Grup 9: Backend — Express App ve Entry Point ──────────────────────────

commit "feat(backend): add Express app with security headers, CORS, rate limiting" \
  backend/src/app.js

commit "feat(backend): add production entry point with graceful shutdown" \
  backend/src/index.js

commit "feat(backend): add backend environment config" \
  backend/.env.example

# ─── Grup 10: Backend — Testler ────────────────────────────────────────────

commit "test(backend): add unit tests for fulfillment, jobs, and logger" \
  backend/test/unit/fulfillment.test.js \
  backend/test/unit/jobs.test.js \
  backend/test/unit/logger.test.js \
  backend/test/unit/sanitize-error.test.js

commit "test(backend): add unit tests for env, audit, vcc-client, and payment-handler" \
  backend/test/unit/env.test.js \
  backend/test/unit/audit.test.js \
  backend/test/unit/vcc-client.test.js \
  backend/test/unit/payment-handler.test.js \
  backend/test/unit/funding-check.test.js

commit "test(backend): add integration tests for orders, status, and agent-status" \
  backend/test/integration/orders.test.js \
  backend/test/integration/status.test.js \
  backend/test/integration/agent-status.test.js \
  backend/test/integration/vcc-callback.test.js \
  backend/test/helpers/app.js

commit "test(backend): add Solana devnet E2E test with payment simulation" \
  backend/test-solana-e2e.js

# ─── Grup 11: VCC Servisi ──────────────────────────────────────────────────

commit "feat(vcc): add virtual card service with Stripe Issuing integration" \
  vcc/src/index.js vcc/package.json vcc/package-lock.json

commit "feat(vcc): add VCC environment config" \
  vcc/.env.example

# ─── Grup 12: SDK ──────────────────────────────────────────────────────────

commit "feat(sdk): initialize TypeScript SDK package (npm: obolus)" \
  sdk/package.json sdk/package-lock.json

commit "feat(sdk): add ObolusClient with createOrder, waitForCard, SSE polling" \
  sdk/src/client.ts sdk/src/index.ts sdk/src/version-check.ts

commit "feat(sdk): add typed error classes and API error parsing" \
  sdk/src/errors.ts

commit "feat(sdk): add MCP server for Claude Desktop integration" \
  sdk/src/mcp.ts

commit "feat(sdk): add CLI (npx obolus) with onboard and purchase commands" \
  sdk/src/cli.ts sdk/src/commands/ sdk/src/config.ts

commit "feat(sdk): add OWS Solana wallet integration" \
  sdk/src/ows.ts sdk/src/solana.ts

commit "test(sdk): add unit and integration tests" \
  sdk/src/__tests__/

commit "docs(sdk): add SDK README and MCP skill definitions" \
  sdk/README.md sdk/skill/

# ─── Grup 13: Web Dashboard ─────────────────────────────────────────────────

commit "feat(web): initialize Next.js dashboard with App Router and Tailwind" \
  web/package.json web/package-lock.json web/next.config.ts \
  web/tsconfig.json web/postcss.config.mjs web/eslint.config.mjs \
  web/vitest.config.ts web/playwright.config.ts web/proxy.ts

commit "feat(web): add dashboard layout, shell, and navigation" \
  web/app/dashboard/layout.tsx \
  web/app/dashboard/page.tsx \
  web/app/dashboard/_lib/ \
  web/app/dashboard/_shell/ \
  web/app/dashboard/_ui/

commit "feat(web): add agent management pages (list, detail, create)" \
  web/app/dashboard/agent/ \
  web/app/dashboard/agents/

commit "feat(web): add orders, feed, and approvals pages" \
  web/app/dashboard/orders/ \
  web/app/dashboard/feed/ \
  web/app/dashboard/approvals/

commit "feat(web): add analytics, alerts, and audit log pages" \
  web/app/dashboard/analytics/ \
  web/app/dashboard/alerts/ \
  web/app/dashboard/audit/

commit "feat(web): add platform admin pages (treasury, health, unmatched, users)" \
  web/app/dashboard/platform/

commit "feat(web): add settings, developer, teams, merchants, and feedback pages" \
  web/app/dashboard/settings/ \
  web/app/dashboard/developer/ \
  web/app/dashboard/teams/ \
  web/app/dashboard/merchants/ \
  web/app/dashboard/feedback/ \
  web/app/dashboard/overview/

commit "feat(web): add BFF API routes (auth, admin-proxy, feedback)" \
  web/app/api/

commit "feat(web): add marketing pages, components, and public assets" \
  web/app/components/ \
  web/app/docs/ \
  web/app/apple-icon.png \
  web/public/

commit "feat(web): add remaining marketing and legal pages" \
  web/app/

commit "test(web): add E2E smoke tests with Playwright" \
  web/e2e/

# ─── Grup 14: Agent ─────────────────────────────────────────────────────────

commit "feat(agent): add Claude-powered autonomous spending agent" \
  agent/src/ agent/package.json agent/package-lock.json agent/.env.example

# ─── Grup 15: Demo Merchant ─────────────────────────────────────────────────

commit "feat(demo): add demo merchant with Stripe test checkout" \
  demo/server.js demo/package.json demo/package-lock.json demo/.env.example

# ─── Grup 16: Dokümantasyon ─────────────────────────────────────────────────

commit "docs: add adversarial security audit report (2026-04-13)" \
  docs/audits/

commit "docs: add feature backlog with roadmap" \
  docs/feature-backlog.md

commit "docs: add AGENTS quick-start guide" \
  AGENTS.md

commit "docs: add system ARCHITECTURE overview" \
  ARCHITECTURE.md

commit "docs: add cleanup and utility scripts" \
  scripts/

commit "docs: add examples directory with node-agent quickstart" \
  examples/

commit "docs: add detailed README with Mermaid diagrams and full API reference" \
  README.md

echo ""
echo "=== Tüm commitler tamamlandı ==="
git log --oneline | head -65
