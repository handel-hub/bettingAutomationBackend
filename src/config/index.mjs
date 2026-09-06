// @ts-check
import { configSchema } from './schema.mjs';
import dotenv from 'dotenv';

dotenv.config();

let cachedConfig = null;

/**
 * Loads, validates, and returns the application configuration.
 * @returns {import('./schema.mjs').Config}
 */
export function loadConfig() {
  if (cachedConfig) return cachedConfig;
  
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Configuration validation failed:', result.error.format());
    process.exit(1);
  }
  
  cachedConfig = result.data;
  return cachedConfig;
}
