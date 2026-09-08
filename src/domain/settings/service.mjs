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
 * @returns {Promise<Object>}
 */
export async function processSettingsIntent(accountId, intent) {
  const pool = getPool();
  const { type, payload = {}, stepUpSecret } = intent;
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
      const { email } = payload;
      if (!email) throw new Error('Email is required');

      await pool.query(`
        UPDATE operator_settings
        SET pending_email = $1, updated_at = now()
        WHERE account_id = $2
      `, [email, accountId]);

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'PROFILE',
        message: `Verification link sent to ${email}`,
        data: { pendingEmail: email }
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
      const { currentPassword, newPassword } = payload;
      if (!currentPassword || !newPassword) {
        return { requestId, status: 'REJECTED', message: 'Current and new password are required' };
      }

      // Check current password
      const accRes = await pool.query('SELECT credentials_hash FROM accounts WHERE account_id = $1', [accountId]);
      const valid = await verifyPassword(currentPassword, accRes.rows[0].credentials_hash);
      if (!valid) {
        return { requestId, status: 'CHALLENGE_FAILED', message: 'Current password is incorrect' };
      }

      const newHash = await hashPassword(newPassword);
      await pool.query('UPDATE accounts SET credentials_hash = $1, updated_at = now() WHERE account_id = $2', [newHash, accountId]);

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'SECURITY',
        message: 'Password updated successfully'
      };
    }

    case 'CONFIGURE_MFA': {
      const { enabled } = payload;
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
      await pool.query(`
        UPDATE sessions
        SET status = 'REVOKED'
        WHERE account_id = $1 AND status = 'AUTHENTICATED'
      `, [accountId]);

      return {
        requestId,
        status: 'ACCEPTED',
        section: 'SECURITY',
        message: 'All other active sessions revoked'
      };
    }

    case 'DELETE_ACCOUNT': {
      if (!stepUpSecret) {
        return {
          requestId,
          status: 'REQUIRES_STEP_UP',
          section: 'SECURITY',
          message: 'Please provide your account password to confirm account deletion'
        };
      }

      const accRes = await pool.query('SELECT credentials_hash FROM accounts WHERE account_id = $1', [accountId]);
      const valid = await verifyPassword(stepUpSecret, accRes.rows[0].credentials_hash);
      if (!valid) {
        return { requestId, status: 'CHALLENGE_FAILED', message: 'Incorrect password confirmation' };
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
