// @ts-check
import { performance } from 'node:perf_hooks';
import { getPool } from './connection.mjs';
import { rootLogger } from '../utils/Logger.mjs';
import { metrics } from '../utils/metrics.mjs';

const txLogger = rootLogger.child({ component: 'Transaction' });

/**
 * Executes a function within a database transaction.
 * @template T
 * @param {'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'} isolationLevel 
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn 
 * @param {number} [maxRetries=3]
 * @returns {Promise<T>}
 */
export async function withTransaction(isolationLevel, fn, maxRetries = 3) {
  const pool = getPool();
  let attempt = 0;

  while (true) {
    const client = await pool.connect();
    const txStart = performance.now();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      const result = await fn(client);
      await client.query('COMMIT');
      const elapsed = performance.now() - txStart;
      metrics.recordTransaction(isolationLevel, elapsed);
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        txLogger.error({
          event: 'db_rollback_failed',
          isolationLevel,
          rollbackErr
        }, 'Failed to execute transaction ROLLBACK');
      }
      
      const isRetryable = error.code === '40001' || error.code === '40P01';
      if (isolationLevel === 'SERIALIZABLE' && isRetryable && attempt < maxRetries) {
        attempt++;
        txLogger.warn({
          event: 'transaction_serialization_retry',
          isolationLevel,
          attempt,
          errCode: error.code
        }, `Retrying SERIALIZABLE transaction due to contention (attempt ${attempt}/${maxRetries})`);
        
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
