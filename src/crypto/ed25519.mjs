// @ts-check
import crypto from 'crypto';

const DOMAIN_PREFIX = Buffer.from('CONTROL_PLANE_V1');

/**
 * Sign a message using Ed25519 with mandatory domain separation.
 * @param {crypto.KeyObject} privateKey
 * @param {Buffer} message
 * @returns {string} hex string (128 chars)
 */
export function sign(privateKey, message) {
  const domainSeparatedMessage = Buffer.concat([DOMAIN_PREFIX, message]);
  return crypto.sign(null, domainSeparatedMessage, privateKey).toString('hex');
}

/**
 * Verify an Ed25519 signature with domain separation.
 * @param {crypto.KeyObject} publicKey
 * @param {Buffer} message
 * @param {string} sigHex
 * @returns {boolean}
 */
export function verify(publicKey, message, sigHex) {
  const domainSeparatedMessage = Buffer.concat([DOMAIN_PREFIX, message]);
  const signature = Buffer.from(sigHex, 'hex');
  return crypto.verify(null, domainSeparatedMessage, publicKey, signature);
}
