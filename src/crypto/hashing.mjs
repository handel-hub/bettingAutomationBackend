// @ts-check
import { hash, verify } from '@node-rs/argon2';
import crypto from 'crypto';

/**
 * Hash a password using Argon2id.
 * @param {string} plaintext
 * @returns {Promise<string>}
 */
export async function hashPassword(plaintext) {
  return hash(plaintext, {
    memoryCost: 65536, // 64 MiB
    timeCost: 3,       // 3 iterations
    parallelism: 1
  });
}

/**
 * Verify a password against an Argon2id hash.
 * @param {string} plaintext
 * @param {string} digest
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plaintext, digest) {
  return verify(digest, plaintext);
}

/**
 * Compute SHA-256 hash.
 * @param {string | Buffer} data
 * @returns {string} hex string
 */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
