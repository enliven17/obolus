// Must be required FIRST in every test file, before any app code.
// Sets the minimum env vars needed to pass Zod validation at module load.

// Fresh temp DB per test run (avoids cross-test bleed when running in parallel)
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

// Solana — fake but shape-valid base58 keys for tests
process.env.SOLANA_NETWORK = 'devnet';
// 64-byte keypair as base58 (valid shape, not a real key)
process.env.SOLANA_TREASURY_SECRET = '2S6WcFwujt478AXbfLuehibp1dhJLgysEwm4pGsko8nfHP3NjonYHAPrLJzfa8AzMjxw9bRcYcCFVdNEH4hCBrJW';
// Valid base58 public key shape
process.env.SOLANA_PROGRAM_ID = '9CQph7JCyba9uWBRGoDmpiGSnZn2gtvqLBTMF7CYKJzK';
process.env.SOLANA_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

// VCC fulfillment service
process.env.VCC_API_BASE = 'http://localhost:5000';
process.env.OBOLUS_BASE_URL = 'https://api.obolus.test';
process.env.VCC_CALLBACK_SECRET = 'test-vcc-callback-secret-32-chars!!';

// SMTP — fake values; email is not called in tests
process.env.SMTP_HOST = 'localhost';
process.env.SMTP_PORT = '25';
process.env.SMTP_USER = 'test';
process.env.SMTP_PASS = 'test';
process.env.SMTP_FROM = 'noreply@obolus.test';

// Raise auth failure limit so tests don't trip the rate limiter
process.env.AUTH_FAILURE_LIMIT_PER_WINDOW = '10000';
