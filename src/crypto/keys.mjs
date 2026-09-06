// @ts-check
import { getPool } from '../persistence/connection.mjs';
import { getKmsAdapter } from './kms-adapter.mjs';

/**
 * @typedef {Object} BackendKey
 * @property {string} key_id
 * @property {number} key_version
 * @property {string} public_key_hex
 * @property {string} status
 */

/**
 * Get the currently ACTIVE backend key from the database.
 * @returns {Promise<BackendKey>}
 */
export async function getActiveKey() {
  const pool = getPool();
  const res = await pool.query(`
    SELECT key_id, key_version, public_key_hex, status 
    FROM backend_keys 
    WHERE status = 'ACTIVE' 
    ORDER BY key_version DESC 
    LIMIT 1
  `);
  
  if (res.rows.length === 0) {
    throw new Error('No active backend key found');
  }
  
  return res.rows[0];
}

/**
 * Get a specific key version for verification purposes (could be ROTATED but still valid for verification).
 * @param {number} version 
 * @returns {Promise<BackendKey>}
 */
export async function getKeyByVersion(version) {
  const pool = getPool();
  const res = await pool.query(`
    SELECT key_id, key_version, public_key_hex, status 
    FROM backend_keys 
    WHERE key_version = $1
  `, [version]);
  
  if (res.rows.length === 0) {
    throw new Error(`Backend key version ${version} not found`);
  }
  
  return res.rows[0];
}

/**
 * Sign a payload using the currently ACTIVE backend key.
 * @param {Buffer} message 
 * @returns {Promise<{ signatureHex: string, keyVersion: number }>}
 */
export async function signWithActiveKey(message) {
  const activeKeyInfo = await getActiveKey();
  const kms = getKmsAdapter();
  
  const privateKey = await kms.getPrivateKey(activeKeyInfo.key_id);
  
  const { sign } = await import('./ed25519.mjs');
  const signatureHex = sign(privateKey, message);
  
  return {
    signatureHex,
    keyVersion: activeKeyInfo.key_version
  };
}
