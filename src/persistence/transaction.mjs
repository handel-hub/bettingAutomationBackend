// @ts-check
import { getPool } from './connection.mjs';

/**
 * Executes a function within a database transaction.
 * @template T
 * @param {'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'} isolationLevel 
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn 
 * @returns {Promise<T>}
 */
export async function withTransaction(isolationLevel, fn) {
  const pool = getPool();
  const client = await pool.connect();
  
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
