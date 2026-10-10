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
    if (!config.KMS_LOCAL_SECRET || config.KMS_LOCAL_SECRET.length < 32) {
      throw new Error('[KMS] KMS_LOCAL_SECRET must be explicitly configured in .env (>= 32 characters).');
    } else {
      this.secret = config.KMS_LOCAL_SECRET;
    }
    this.keys = new Map();
  }

  /**
   * Return the hex-encoded Ed25519 public key for a given key version.
   * @param {string} [versionTag='v1']
   * @returns {string}
   */
  getPublicKeyHex(versionTag = 'v1') {
    const { publicKeyHex } = deriveKeyPair(this.secret, versionTag);
    return publicKeyHex;
  }

  /**
   * Eagerly initialize the KMS adapter and ensure the active backend key in PostgreSQL matches.
   * @returns {Promise<string>} The active publicKeyHex
   */
  async initialize() {
    const publicKeyHex = this.getPublicKeyHex('v1');
    try {
      const { getPool } = await import('../persistence/connection.mjs');
      const pool = getPool();
      await pool.query(`
        INSERT INTO backend_keys (key_version, public_key_hex, status, activated_at)
        VALUES (1, $1, 'ACTIVE', now())
        ON CONFLICT (key_version) DO UPDATE SET public_key_hex = EXCLUDED.public_key_hex, status = 'ACTIVE';
      `, [publicKeyHex]);
    } catch {
      // Ignore if DB is not connected yet in unit tests
    }
    return publicKeyHex;
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

/** @type {LocalKmsAdapter} */
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

export function resetKmsAdapter() {
  adapterInstance = undefined;
}

