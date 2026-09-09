// @ts-check
import { getPool } from './connection.mjs';

/**
 * Executes a function within a database transaction.
 * @template T
 * @param {'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'} isolationLevel 
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn 
 * @returns {Promise<T>}
 */
export async function withTransaction(isolationLevel, fn, maxRetries = 3) {
  const pool = getPool();
  let attempt = 0;

  while (true) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      
      const isRetryable = error.code === '40001' || error.code === '40P01';
      if (isolationLevel === 'SERIALIZABLE' && isRetryable && attempt < maxRetries) {
        attempt++;
        const backoffMs = Math.floor(Math.pow(2, attempt) * 25 + Math.random() * 25);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
