// @ts-check
import { getPool } from '../persistence/connection.mjs';

/**
 * Validates a nonce, checking against the database for uniqueness.
 * @param {string} nonce 
 * @param {number} epoch 
 * @returns {Promise<void>} throws if invalid or duplicate
 */
export async function useNonce(nonce, epoch) {
  const pool = getPool();
  
  if (!nonce || nonce.length < 16) {
    throw new Error('Invalid nonce format');
  }

  try {
    await pool.query(
      `INSERT INTO server_nonces (nonce, epoch) VALUES ($1, $2)`,
      [nonce, epoch]
    );
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      throw new Error('DUPLICATE_NONCE');
    }
    throw err;
  }
}
