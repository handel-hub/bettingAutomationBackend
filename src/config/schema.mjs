// @ts-check
import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  SESSION_LIFETIME_MS: z.coerce.number().min(1000).default(3600000),
  KEYGEN_API_KEY: z.string().min(1).default('default_keygen_key'),
  KEYGEN_BASE_URL: z.string().optional().default('http://localhost:4000/v1'),
  KEYGEN_PRODUCT_TOKEN: z.string().optional(),
  KEYGEN_ACCOUNT_ID: z.string().optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().min(1).default('default_webhook_secret'),
  PAYSTACK_SECRET_KEY: z.string().min(1).optional(),
  PAYSTACK_PUBLIC_KEY: z.string().min(1).optional(),
  KMS_PROVIDER: z.enum(['aws', 'local']).default('local'),
  KMS_LOCAL_SECRET: z.string().optional(),
  SERVER_EPOCH_FILE: z.string().optional(),
  UPLOAD_DIR: z.string().optional().default('/tmp/uploads'),
  LOG_LEVEL: z.string().optional().default('info'),
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().default(10),
  CIRCUIT_BREAKER_WINDOW_MS: z.coerce.number().default(60000),
  SEAT_LIMIT_MAX: z.coerce.number().default(5),
  NONCE_TTL_SECONDS: z.coerce.number().default(30)
});

/**
 * @typedef {z.infer<typeof configSchema>} Config
 */
