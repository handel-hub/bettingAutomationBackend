// @ts-check
import { verifyPassword } from '../../crypto/hashing.mjs';

const LOCKOUT_THRESHOLDS = [
  60 * 1000,          // 1m
  5 * 60 * 1000,      // 5m
  15 * 60 * 1000,     // 15m
  60 * 60 * 1000,     // 1h
  24 * 60 * 60 * 1000 // 24h
];

const LOCKOUT_ATTEMPT_LIMIT = 5;

/**
 * Perform lockout checks and credential verification
 * @param {any} account 
 * @param {string} password 
 * @returns {Promise<{ success: boolean; locked?: boolean; lockoutExpiresAt?: Date | null; newCount?: number }>}
 */
export async function verifyCredentials(account, password) {
  const isValid = await verifyPassword(password, account.credentials_hash);

  if (account.status === 'LOCKED' || account.status === 'SUSPENDED' || account.status === 'DELETED') {
    return { success: false };
  }

  if (account.lockout_expires_at && new Date(account.lockout_expires_at) > new Date()) {
    const err = new Error('ACCOUNT_LOCKED');
    // @ts-ignore
    err.status = 423;
    // @ts-ignore
    err.code = 'ACCOUNT_LOCKED';
    throw err;
  }

  if (!isValid) {
    const nextCount = Number(account.lockout_count || 0) + 1;
    let lockoutExpiresAt = null;
    if (nextCount >= LOCKOUT_ATTEMPT_LIMIT) {
      const thresholdIndex = Math.min(nextCount - LOCKOUT_ATTEMPT_LIMIT, LOCKOUT_THRESHOLDS.length - 1);
      const lockoutDurationMs = LOCKOUT_THRESHOLDS[thresholdIndex];
      lockoutExpiresAt = new Date(Date.now() + lockoutDurationMs);
    }

    return {
      success: false,
      newCount: nextCount,
      lockoutExpiresAt
    };
  }

  return { success: true, newCount: 0, lockoutExpiresAt: null };
}
