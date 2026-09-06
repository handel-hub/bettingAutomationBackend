// @ts-check
import crypto from 'crypto';
import { loadConfig } from '../config/index.mjs';

/**
 * Interface for KMS Adapter
 * @typedef {Object} KmsAdapter
 * @property {(keyId: string) => Promise<crypto.KeyObject>} getPrivateKey
 */

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
   * Deterministically generate a private key for development purposes based on the keyId
   * @param {string} keyId 
   * @returns {Promise<crypto.KeyObject>}
   */
  async getPrivateKey(keyId) {
    if (this.keys.has(keyId)) return this.keys.get(keyId);
    
    // For a real local KMS, we would persist keys. This just generates a transient one for testing and caches it in memory.
    const keyPair = crypto.generateKeyPairSync('ed25519');
    this.keys.set(keyId, keyPair.privateKey);
    return keyPair.privateKey;
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
