// @ts-check
import { getPool } from '../../persistence/connection.mjs';
import { verifyPassword, hashPassword } from '../../crypto/hashing.mjs';
import crypto from 'crypto';

/**
 * Fetch SettingsSnapshot for an operator.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function getSettingsSnapshot(accountId) {
  const pool = getPool();

  // 1. Fetch account core
  const accRes = await pool.query('SELECT email FROM accounts WHERE account_id = $1', [accountId]);
  const email = accRes.rows[0]?.email || 'operator@bettingautomation.io';

  // 2. Fetch or initialize operator_settings
  let settingsRes = await pool.query('SELECT * FROM operator_settings WHERE account_id = $1', [accountId]);
  if (settingsRes.rows.length === 0) {
    await pool.query(`
      INSERT INTO operator_settings (account_id, name)
      VALUES ($1, 'Operator')
      ON CONFLICT (account_id) DO NOTHING
    `, [accountId]);
    settingsRes = await pool.query('SELECT * FROM operator_settings WHERE account_id = $1', [accountId]);
  }
  const settings = settingsRes.rows[0] || {};

  // 3. Count active sessions
  const sessionsRes = await pool.query(
    "SELECT COUNT(*) FROM sessions WHERE account_id = $1 AND status = 'AUTHENTICATED' AND expires_at > now()",
    [accountId]
  );
  const activeSessions = Number(sessionsRes.rows[0]?.count || 1);

  return {
    profile: {
      status: 'AVAILABLE',
      data: {
        name: settings.name || 'Operator',
        email,
        pendingEmail: settings.pending_email || null,
        avatarUrl: settings.avatar_url || null
      }
    },
    security: {
      status: 'AVAILABLE',
      data: {
        accountStatus: settings.account_status || 'ACTIVE',
        deletionScheduledAt: settings.deletion_scheduled_at || null,
        mfaEnabled: Boolean(settings.mfa_enabled),
        activeSessions
      }
    },
    automationPreferences: {
      status: 'AVAILABLE',
      data: settings.automation_preferences || { defaultExecutionMode: 'auto', maxConcurrentRuns: 2 }
    },
    notifications: {
      status: 'AVAILABLE',
      data: settings.notification_preferences || { emailAlerts: true, pushAlerts: true, weeklyReport: false }
    },
    presentationPreferences: settings.presentation_preferences || { theme: 'system', density: 'comfortable' },
    capabilities: {
      canChangeName: true,
      canChangeEmail: true,
      canChangePassword: true,
      canConfigureMFA: true,
      canRevokeSessions: true,
      canDeleteAccount: true,
      canCancelDeletion: settings.account_status === 'PENDING_DELETION'
    }
  };
}

/**
 * Handle SettingsIntentRequest with step-up verification if needed.
 * @param {string} accountId 
 * @param {Object} intent 
 * @param {string} intent.type 
 * @param {Record<string, any>} intent.payload 
 * @param {string} [intent.stepUpSecret]
 * @param {{ currentSessionId?: string | null }} [context]
 * @returns {Promise<Object>}
 */
export async function processSettingsIntent(accountId, intent, context = {}) {
  const pool = getPool();
  const { type, payload = {}, stepUpSecret } = intent;
  const currentSessionId = context?.currentSessionId || intent?.currentSessionId || null;
  const requestId = `req-${crypto.randomUUID()}`;

  switch (type) {
    case 'UPDATE_PROFILE': {
      const { name, avatarUrl } = payload;
      await pool.query(`
        UPDATE operator_settings
        SET name = COALESCE($1, name),
            avatar_url = COALESCE($2, avatar_url),
            updated_at = now()
        WHERE account_id = $3
      `, [name || null, avatarUrl || null, accountId]);

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'PROFILE',
        message: 'Profile updated successfully',
        data: { name, avatarUrl }
      };
    }

    case 'CHANGE_EMAIL': {
      const rawEmail = payload?.email;
      if (!rawEmail || typeof rawEmail !== 'string') throw new Error('Email is required');
      const normalizedEmail = rawEmail.trim().toLowerCase();
      const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!EMAIL_REGEX.test(normalizedEmail)) {
        return {
          requestId,
          status: 'REJECTED',
          section: 'PROFILE',
          message: 'Invalid email address format'
        };
      }

      const secret = stepUpSecret || payload.currentPassword;
      if (!secret) {
        return {
          requestId,
          status: 'REQUIRES_STEP_UP',
          section: 'SECURITY',
          message: 'Please provide your current password to confirm email change'
        };
      }

      const accRes = await pool.query('SELECT credentials_hash FROM accounts WHERE account_id = $1', [accountId]);
      const valid = accRes.rows[0]?.credentials_hash
        ? await verifyPassword(String(secret), accRes.rows[0].credentials_hash).catch(() => false)
        : false;
      if (!valid) {
        return { requestId, status: 'CHALLENGE_FAILED', section: 'SECURITY', message: 'Current password is incorrect' };
      }

      const dupRes = await pool.query(
        'SELECT 1 FROM accounts WHERE LOWER(email) = $1 AND account_id != $2 LIMIT 1',
        [normalizedEmail, accountId]
      );
      if (dupRes.rows.length > 0) {
        return {
          requestId,
          status: 'REJECTED',
          section: 'PROFILE',
          message: 'Email address is already in use by another account'
        };
      }

      await pool.query(`
        UPDATE operator_settings
        SET pending_email = $1, updated_at = now()
        WHERE account_id = $2
      `, [normalizedEmail, accountId]);

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'PROFILE',
        message: `Verification link sent to ${normalizedEmail}`,
        data: { pendingEmail: normalizedEmail }
      };
    }

    case 'CANCEL_EMAIL_CHANGE': {
      await pool.query(`
        UPDATE operator_settings
        SET pending_email = null, updated_at = now()
        WHERE account_id = $1
      `, [accountId]);

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'PROFILE',
        message: 'Pending email change cancelled'
      };
    }

    case 'UPDATE_PASSWORD': {
      const currentPassword = stepUpSecret || payload.currentPassword;
      const { newPassword } = payload;
      if (!currentPassword) {
        return {
          requestId,
          status: 'REQUIRES_STEP_UP',
          section: 'SECURITY',
          message: 'Step-up authorization required (current password)'
        };
      }
      if (!newPassword || String(newPassword).length < 8) {
        return { requestId, status: 'REJECTED', section: 'SECURITY', message: 'New password must be at least 8 characters' };
      }

      // Check current password against credentials_hash
      const accRes = await pool.query('SELECT credentials_hash FROM accounts WHERE account_id = $1', [accountId]);
      const valid = accRes.rows[0]?.credentials_hash
        ? await verifyPassword(String(currentPassword), accRes.rows[0].credentials_hash).catch(() => false)
        : false;
      if (!valid) {
        return { requestId, status: 'CHALLENGE_FAILED', section: 'SECURITY', message: 'Current password is incorrect' };
      }

      const newHash = await hashPassword(String(newPassword));
      await pool.query('UPDATE accounts SET credentials_hash = $1, updated_at = now() WHERE account_id = $2', [newHash, accountId]);

      // Revoke all OTHER active sessions for this account and bump their machine session_generation
      const revokedOtherRes = await pool.query(`
        UPDATE sessions
        SET status = 'REVOKED'
        WHERE account_id = $1
          AND status = 'AUTHENTICATED'
          AND ($2::uuid IS NULL OR session_id != $2)
        RETURNING session_id, machine_id
      `, [accountId, currentSessionId]);

      if (revokedOtherRes.rows.length > 0) {
        const revokedSessionIds = revokedOtherRes.rows.map((r) => r.session_id);
        const affectedMachineIds = Array.from(new Set(revokedOtherRes.rows.map((r) => r.machine_id).filter(Boolean)));
        await pool.query(`
          UPDATE authorizations
          SET status = 'REVOKED', updated_at = now()
          WHERE session_id = ANY($1::uuid[]) AND status = 'VALID'
        `, [revokedSessionIds]);
        if (affectedMachineIds.length > 0) {
          await pool.query(`
            UPDATE machine_session_states
            SET session_generation = session_generation + 1, updated_at = now()
            WHERE account_id = $1 AND machine_id = ANY($2::uuid[])
          `, [accountId, affectedMachineIds]);
        }
      }

      try {
        const { closeWebSocketsForTarget } = await import('../../websocket/server.mjs');
        closeWebSocketsForTarget({ accountId, excludeSessionId: currentSessionId });
      } catch {
        // ignore
      }

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'SECURITY',
        message: 'Password updated successfully'
      };
    }

    case 'CONFIGURE_MFA': {
      const { enabled } = payload;
      if (!enabled) {
        const curMfaRes = await pool.query('SELECT mfa_enabled FROM operator_settings WHERE account_id = $1', [accountId]);
        if (curMfaRes.rows[0]?.mfa_enabled) {
          const secret = stepUpSecret || payload.currentPassword;
          if (!secret) {
            return {
              requestId,
              status: 'REQUIRES_STEP_UP',
              section: 'SECURITY',
              message: 'Step-up authorization required to disable two-factor authentication'
            };
          }
          const accRes = await pool.query('SELECT credentials_hash FROM accounts WHERE account_id = $1', [accountId]);
          const valid = accRes.rows[0]?.credentials_hash
            ? await verifyPassword(String(secret), accRes.rows[0].credentials_hash).catch(() => false)
            : false;
          if (!valid) {
            return { requestId, status: 'CHALLENGE_FAILED', section: 'SECURITY', message: 'Current password is incorrect' };
          }
        }
      }
      await pool.query(`
        UPDATE operator_settings
        SET mfa_enabled = $1, updated_at = now()
        WHERE account_id = $2
      `, [Boolean(enabled), accountId]);

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'SECURITY',
        message: `Two-factor authentication ${enabled ? 'enabled' : 'disabled'}`
      };
    }

    case 'REVOKE_SESSIONS': {
      const revokedSessionsRes = await pool.query(`
        UPDATE sessions
        SET status = 'REVOKED'
        WHERE account_id = $1
          AND status = 'AUTHENTICATED'
          AND ($2::uuid IS NULL OR session_id != $2)
        RETURNING session_id, machine_id
      `, [accountId, currentSessionId]);

      if (revokedSessionsRes.rows.length > 0) {
        const revokedSessionIds = revokedSessionsRes.rows.map((r) => r.session_id);
        const affectedMachineIds = Array.from(new Set(revokedSessionsRes.rows.map((r) => r.machine_id).filter(Boolean)));
        await pool.query(`
          UPDATE authorizations
          SET status = 'REVOKED', updated_at = now()
          WHERE session_id = ANY($1::uuid[]) AND status = 'VALID'
        `, [revokedSessionIds]);
        if (affectedMachineIds.length > 0) {
          await pool.query(`
            UPDATE machine_session_states
            SET session_generation = session_generation + 1, updated_at = now()
            WHERE account_id = $1 AND machine_id = ANY($2::uuid[])
          `, [accountId, affectedMachineIds]);
        }
      } else if (!currentSessionId) {
        await pool.query(`
          UPDATE authorizations
          SET status = 'REVOKED', updated_at = now()
          WHERE account_id = $1 AND status = 'VALID'
        `, [accountId]);
        await pool.query(`
          UPDATE machine_session_states
          SET session_generation = session_generation + 1, updated_at = now()
          WHERE account_id = $1
        `, [accountId]);
      }

      try {
        const { closeWebSocketsForTarget } = await import('../../websocket/server.mjs');
        closeWebSocketsForTarget({ accountId, excludeSessionId: currentSessionId });
      } catch {
        // ignore
      }

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'SECURITY',
        message: 'All other active sessions revoked'
      };
    }

    case 'DELETE_ACCOUNT': {
      const secret = stepUpSecret || payload?.currentPassword;
      if (!secret) {
        return {
          requestId,
          status: 'REQUIRES_STEP_UP',
          section: 'SECURITY',
          message: 'Please provide your account password to confirm account deletion'
        };
      }

      const accRes = await pool.query('SELECT credentials_hash FROM accounts WHERE account_id = $1', [accountId]);
      const valid = accRes.rows[0]?.credentials_hash
        ? await verifyPassword(String(secret), accRes.rows[0].credentials_hash).catch(() => false)
        : false;
      if (!valid) {
        return { requestId, status: 'CHALLENGE_FAILED', section: 'SECURITY', message: 'Incorrect password confirmation' };
      }

      const deletionDate = new Date(Date.now() + 14 * 86400000).toISOString();
      await pool.query(`
        UPDATE operator_settings
        SET account_status = 'PENDING_DELETION',
            deletion_scheduled_at = $1,
            updated_at = now()
        WHERE account_id = $2
      `, [deletionDate, accountId]);

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'SECURITY',
        message: 'Account scheduled for permanent deletion in 14 days',
        data: { deletionScheduledAt: deletionDate }
      };
    }

    case 'CANCEL_DELETION': {
      await pool.query(`
        UPDATE operator_settings
        SET account_status = 'ACTIVE',
            deletion_scheduled_at = null,
            updated_at = now()
        WHERE account_id = $1
      `, [accountId]);

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'SECURITY',
        message: 'Account deletion cancelled'
      };
    }

    case 'UPDATE_NOTIFICATIONS': {
      await pool.query(`
        UPDATE operator_settings
        SET notification_preferences = notification_preferences || $1::jsonb,
            updated_at = now()
        WHERE account_id = $2
      `, [JSON.stringify(payload), accountId]);

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'NOTIFICATIONS',
        message: 'Notification preferences updated'
      };
    }

    default:
      return { requestId, status: 'REJECTED', message: `Unknown intent type: ${type}` };
  }
}
