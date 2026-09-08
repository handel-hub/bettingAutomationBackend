// @ts-check
import crypto from 'crypto';
import { loadConfig } from '../config/index.mjs';

/**
 * Interface for KMS Adapter
 * @typedef {Object} KmsAdapter
 * @property {(keyId: string) => Promise<crypto.KeyObject>} getPrivateKey
 */

/**
 * Deterministically derive an Ed25519 keypair from a secret and key identifier.
 * @param {string} secret 
 * @param {string} [keyId='default'] 
 * @returns {{ privateKey: crypto.KeyObject, publicKey: crypto.KeyObject, publicKeyHex: string }}
 */
export function deriveKeyPair(secret, keyId = 'default') {
  const seed = crypto.createHash('sha256').update(`${secret}:${keyId}`).digest();
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const privKeyDer = Buffer.concat([prefix, seed]);
  const privateKey = crypto.createPrivateKey({ key: privKeyDer, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  const spkiBuffer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPubBuffer = spkiBuffer.subarray(spkiBuffer.length - 32);
  const publicKeyHex = rawPubBuffer.toString('hex');
  return { privateKey, publicKey, publicKeyHex };
}

/**
 * Local KMS adapter for development. In production, an AWS KMS adapter would be used.
 * @implements {KmsAdapter}
 */
class LocalKmsAdapter {
  constructor() {
    const config = loadConfig();
    this.secret = config.KMS_LOCAL_SECRET || 'default_local_dev_secret_32_bytes_long';
    this.keys = new Map();
  }

  /**
   * Deterministically generate a private key based on the secret and keyId
   * @param {string} keyId 
   * @returns {Promise<crypto.KeyObject>}
   */
  async getPrivateKey(keyId) {
    if (this.keys.has(keyId)) return this.keys.get(keyId);
    
    // Deterministic Ed25519 key derivation matching bootstrap-key.mjs by version
    let keyVersion = '1';
    try {
      const { getPool } = await import('../persistence/connection.mjs');
      const pool = getPool();
      const res = await pool.query('SELECT key_version FROM backend_keys WHERE key_id = $1', [keyId]);
      if (res.rows.length > 0) {
        keyVersion = String(res.rows[0].key_version);
      }
    } catch {
      // Fallback if DB is unavailable
    }
    
    const { privateKey } = deriveKeyPair(this.secret, `v${keyVersion}`);
    this.keys.set(keyId, privateKey);
    return privateKey;
  }
}

/** @type {KmsAdapter} */
let adapterInstance;

export function getKmsAdapter() {
  if (!adapterInstance) {
    const config = loadConfig();
    if (config.KMS_PROVIDER === 'aws') {
      throw new Error('AWS KMS adapter not fully implemented yet');
    } else {
      adapterInstance = new LocalKmsAdapter();
    }
  }
  return adapterInstance;
}
