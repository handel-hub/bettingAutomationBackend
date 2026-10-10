// @ts-check
import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3001),
  SESSION_LIFETIME_MS: z.coerce.number().min(1000).default(3600000),
  KEYGEN_API_KEY: z.string().min(1).default('default_keygen_key'),
  KEYGEN_BASE_URL: z.string().optional().default('http://localhost:4000/v1'),
  KEYGEN_PRODUCT_TOKEN: z.string().optional(),
  KEYGEN_ACCOUNT_ID: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(['paystack', 'flutterwave', 'stub']).default('paystack'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(1).default('default_webhook_secret'),
  PAYSTACK_SECRET_KEY: z.string().min(1).optional(),
  PAYSTACK_PUBLIC_KEY: z.string().min(1).optional(),
  FLW_SECRET_KEY: z.string().min(1).optional(),
  FLW_PUBLIC_KEY: z.string().min(1).optional(),
  FLW_ENCRYPTION_KEY: z.string().min(1).optional(),
  FLW_SECRET_HASH: z.string().min(1).optional(),
  WEBHOOK_SECRET_HASH: z.string().min(1).optional(),
  FLW_WEBHOOK_SECRET_HASH: z.string().min(1).optional(),
  KMS_PROVIDER: z.enum(['aws', 'local']).default('local'),
  KMS_LOCAL_SECRET: z.string().optional(),
  SERVER_EPOCH_FILE: z.string().optional(),
  UPLOAD_DIR: z.string().optional().default('/tmp/uploads'),
  LOG_LEVEL: z.string().optional().default('info'),
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().default(10),
  CIRCUIT_BREAKER_WINDOW_MS: z.coerce.number().default(60000),
  SEAT_LIMIT_MAX: z.coerce.number().default(5),
  NONCE_TTL_SECONDS: z.coerce.number().default(30),
  ALLOW_TEST_PAYMENT_STUB: z.enum(['true', 'false']).optional().default('false'),
  ALLOW_TEST_PROVISIONING: z.enum(['true', 'false']).optional().default('false'),
  AUTO_SEED_TEST_DATA: z.enum(['true', 'false']).optional().default('false')
}).superRefine((val, ctx) => {
  if (val.NODE_ENV === 'production') {
    if (
      val.KMS_PROVIDER === 'local' &&
      (!val.KMS_LOCAL_SECRET || val.KMS_LOCAL_SECRET.length < 32 || val.KMS_LOCAL_SECRET === 'default_local_dev_secret_32_bytes_long')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KMS_LOCAL_SECRET'],
        message: 'KMS_LOCAL_SECRET must be explicitly set (>= 32 chars, non-default) in production.'
      });
    }
    if (val.PAYMENT_WEBHOOK_SECRET === 'default_webhook_secret' && !val.WEBHOOK_SECRET_HASH && !val.FLW_WEBHOOK_SECRET_HASH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_WEBHOOK_SECRET'],
        message: 'PAYMENT_WEBHOOK_SECRET or WEBHOOK_SECRET_HASH must be explicitly configured in production.'
      });
    }
    if (val.PAYMENT_PROVIDER === 'stub') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_PROVIDER'],
        message: 'PAYMENT_PROVIDER cannot be "stub" in production.'
      });
    }
  }
});

/**
 * @typedef {z.infer<typeof configSchema>} Config
 */

