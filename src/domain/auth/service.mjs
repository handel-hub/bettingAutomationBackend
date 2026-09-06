// @ts-check
import { verifyPassword } from '../../crypto/hashing.mjs';

const LOCKOUT_THRESHOLDS = [
  60 * 1000,          // 1m
  5 * 60 * 1000,      // 5m
  15 * 60 * 1000,     // 15m
  60 * 60 * 1000,     // 1h
  24 * 60 * 60 * 1000 // 24h
];

/**
 * Perform lockout checks and credential verification
 * @param {any} account 
 * @param {string} password 
 * @returns {Promise<{ success: boolean; lockoutExpiresAt?: Date; newCount?: number }>}
 */
export async function verifyCredentials(account, password) {
  if (account.status === 'LOCKED' || account.status === 'SUSPENDED' || account.status === 'DELETED') {
    return { success: false };
  }

  if (account.lockout_expires_at && account.lockout_expires_at > new Date()) {
    throw new Error('ACCOUNT_LOCKED');
  }

  const isValid = await verifyPassword(password, account.credentials_hash);

  if (!isValid) {
    const nextCount = account.lockout_count + 1;
    const thresholdIndex = Math.min(nextCount - 1, LOCKOUT_THRESHOLDS.length - 1);
    const lockoutDurationMs = LOCKOUT_THRESHOLDS[thresholdIndex];
    
    return {
      success: false,
      newCount: nextCount,
      lockoutExpiresAt: new Date(Date.now() + lockoutDurationMs)
    };
  }

  return { success: true, newCount: 0, lockoutExpiresAt: null };
}
