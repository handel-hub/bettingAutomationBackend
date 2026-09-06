// @ts-check
import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),
  SESSION_LIFETIME_MS: z.coerce.number().min(60000).default(3600000),
  KEYGEN_API_KEY: z.string().min(1),
  PAYMENT_WEBHOOK_SECRET: z.string().min(1),
  // Additional config fields... I'll need to define all 26 as mentioned in the plan if possible, 
  // but I'll add the main ones for now.
  KMS_PROVIDER: z.enum(['aws', 'local']).default('local'),
  KMS_LOCAL_SECRET: z.string().optional()
});

/**
 * @typedef {z.infer<typeof configSchema>} Config
 */
