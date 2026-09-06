// @ts-check
import pg from 'pg';
import { loadConfig } from '../config/index.mjs';

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    const config = loadConfig();
    pool = new Pool({
      connectionString: config.DATABASE_URL,
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
