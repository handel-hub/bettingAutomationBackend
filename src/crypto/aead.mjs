// @ts-check
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits is standard for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Encrypt a plaintext buffer using AES-256-GCM.
 * @param {Buffer} key 32-byte key
 * @param {Buffer} plaintext
 * @param {Buffer} [aad] Additional Authenticated Data
 * @returns {{nonce: string, ciphertext: string, tag: string}} hex encoded strings
 */
export function encrypt(key, plaintext, aad) {
  const nonce = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);
  
  if (aad) {
    cipher.setAAD(aad);
  }
  
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  return {
    nonce: nonce.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex')
  };
}

/**
 * Decrypt a ciphertext using AES-256-GCM.
 * @param {Buffer} key 32-byte key
 * @param {string} nonceHex
 * @param {string} ciphertextHex
 * @param {string} tagHex
 * @param {Buffer} [aad]
 * @returns {Buffer}
 */
export function decrypt(key, nonceHex, ciphertextHex, tagHex, aad) {
  const nonce = Buffer.from(nonceHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  
  if (aad) {
    decipher.setAAD(aad);
  }
  
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
