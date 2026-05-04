// @ts-check
// Environment variable validation for Obolus backend.
// Validates all required env vars at startup — fails fast with clear errors.

const { z } = require('zod');

function httpUrl(fieldName) {
  return z
    .string()
    .url(`${fieldName} must be a valid URL`)
    .refine((v) => /^https?:\/\//i.test(v), {
      message: `${fieldName} must use http:// or https:// scheme`,
    });
}

function commaSeparatedEmails(fieldName) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      return v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    })
    .refine(
      (list) => {
        if (!list) return true;
        return list.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      },
      { message: `${fieldName} contains an invalid email` },
    );
}

function commaSeparatedOrigins(fieldName) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      return v.split(',').map((s) => s.trim()).filter(Boolean);
    })
    .refine(
      (list) => {
        if (!list) return true;
        return list.every((o) => {
          try {
            const u = new URL(o);
            return u.origin !== 'null' && /^https?:$/i.test(u.protocol);
          } catch {
            return false;
          }
        });
      },
      { message: `${fieldName} contains an invalid origin (must be http(s) URLs, comma-separated)` },
    );
}

// Solana base58 public key: 32–44 base58 chars
function solanaPublicKey(fieldName) {
  return z
    .string()
    .regex(
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
      `${fieldName} must be a valid Solana base58 public key`,
    );
}

// Solana base58 secret key (88 chars for 64-byte keypair) or raw hex (128 chars)
function solanaSecretKey(fieldName) {
  return z
    .string()
    .refine(
      (v) => /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(v) || /^[0-9a-fA-F]{128}$/.test(v),
      {
        message: `${fieldName} must be a valid Solana secret key (base58 or 128-char hex)`,
      },
    );
}

const EnvSchema = z
  .object({
    // Server
    PORT: z
      .string()
      .regex(/^\d+$/, 'PORT must be a positive integer (e.g. "4000")')
      .default('4000'),
    NODE_ENV: z.enum(['development', 'production', 'test'], {
      errorMap: () => ({
        message: 'NODE_ENV must be one of: development | production | test',
      }),
    }),

    // Database
    DB_PATH: z.string().default('./obolus.db'),

    // Solana — treasury wallet + program
    SOLANA_NETWORK: z.enum(['devnet', 'mainnet-beta']).default('devnet'),
    SOLANA_RPC_URL: httpUrl('SOLANA_RPC_URL').optional(),
    SOLANA_TREASURY_SECRET: solanaSecretKey('SOLANA_TREASURY_SECRET'),
    SOLANA_PROGRAM_ID: solanaPublicKey('SOLANA_PROGRAM_ID'),
    // USDC mint: devnet default is the Circle devnet USDC mint
    SOLANA_USDC_MINT: solanaPublicKey('SOLANA_USDC_MINT').default(
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    ),

    // VCC fulfillment service
    VCC_API_BASE: httpUrl('VCC_API_BASE'),
    OBOLUS_BASE_URL: httpUrl('OBOLUS_BASE_URL'),
    VCC_CALLBACK_SECRET: z
      .string()
      .min(32, 'VCC_CALLBACK_SECRET must be at least 32 characters'),

    // Bags integration
    BAGS_API_KEY: z.string().optional(),
    BAGS_PROJECT_ID: z.string().optional(),
    BAGS_TOKEN_MINT: solanaPublicKey('BAGS_TOKEN_MINT').optional(),

    // AI Agent
    ANTHROPIC_API_KEY: z.string().optional(),

    // CORS
    CORS_ORIGINS: commaSeparatedOrigins('CORS_ORIGINS'),

    // Auth
    OWNER_EMAIL: z.string().email().optional().or(z.literal('').transform(() => undefined)),
    OBOLUS_PLATFORM_OWNER_EMAIL: z
      .string()
      .email()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    INTERNAL_EMAILS: commaSeparatedEmails('INTERNAL_EMAILS'),

    // SMTP
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.string().regex(/^\d+$/, 'SMTP_PORT must be numeric').optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().email('SMTP_FROM must be a valid email address').optional(),

    // Recovery job knobs
    STUCK_RETRY_AFTER_MS: z.string().regex(/^\d+$/).optional(),
    STUCK_FAIL_AFTER_MS: z.string().regex(/^\d+$/).optional(),
    MAX_FULFILLMENT_ATTEMPTS: z.string().regex(/^\d+$/).optional(),

    // Secret-box key — AES-256-GCM, seals DB secrets (claim payloads, card data)
    OBOLUS_SECRET_BOX_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'OBOLUS_SECRET_BOX_KEY must be 64 hex characters (32 bytes)')
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV === 'production' && !val.OBOLUS_SECRET_BOX_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'OBOLUS_SECRET_BOX_KEY is required in production. ' +
          'Generate with: openssl rand -hex 32',
        path: ['OBOLUS_SECRET_BOX_KEY'],
      });
    }
  })
  .superRefine((val, ctx) => {
    const smtpKeys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
    const set = smtpKeys.filter((k) => val[k]);
    if (set.length > 0 && set.length < smtpKeys.length) {
      const missing = smtpKeys.filter((k) => !val[k]);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `SMTP is partially configured: missing ${missing.join(', ')}`,
        path: ['SMTP_HOST'],
      });
    }
  });

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  const missing = result.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`[env] Invalid environment variables:\n${missing}`);
  process.exit(1);
}

module.exports = { env: result.data, _EnvSchema: EnvSchema };
