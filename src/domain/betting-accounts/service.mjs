// @ts-check
import { getPool } from '../../persistence/connection.mjs';
import { withTransaction } from '../../persistence/transaction.mjs';
import { encrypt, decrypt } from '../../crypto/aead.mjs';
import crypto from 'crypto';

// Master key for AEAD AES-256-GCM encryption of stored betting passwords
const MASTER_VAULT_KEY = crypto.createHash('sha256').update(process.env.KMS_LOCAL_SECRET || 'betting_automation_master_vault_key_32').digest();

/**
 * Mask sensitive credentials for API responses
 * @param {string} [pass]
 * @returns {string}
 */
function maskPassword(pass) {
  return '********';
}

/**
 * Register a new betting account with encrypted password storage.
 * @param {string} accountId 
 * @param {Object} data 
 * @param {string} data.name 
 * @param {string} data.platformDisplayName 
 * @param {string} data.accountUsername 
 * @param {string} data.accountPassword 
 * @param {string[]} [data.tags]
 * @returns {Promise<Object>}
 */
export async function createBettingAccount(accountId, data) {
  const { name, platformDisplayName, accountUsername, accountPassword, tags = [] } = data;

  if (!platformDisplayName || !accountUsername || !accountPassword) {
    throw new Error('Platform, username, and password are required');
  }

  // Encrypt password using AES-256-GCM
  const aad = Buffer.from(`${accountId}:${platformDisplayName}:${accountUsername}`);
  const { nonce, ciphertext, tag } = encrypt(MASTER_VAULT_KEY, Buffer.from(accountPassword, 'utf8'), aad);

  return withTransaction('READ COMMITTED', async (client) => {
    const insertRes = await client.query(`
      INSERT INTO betting_accounts (
        account_id, name, platform_display_name, account_username,
        account_password_encrypted, password_iv, password_tag, tags
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      accountId,
      name || `${platformDisplayName} - ${accountUsername}`,
      platformDisplayName,
      accountUsername,
      ciphertext,
      nonce,
      tag,
      JSON.stringify(tags)
    ]);

    const acc = insertRes.rows[0];

    // Create default automation account config
    await client.query(`
      INSERT INTO automation_account_configs (account_id)
      VALUES ($1)
      ON CONFLICT (account_id) DO NOTHING
    `, [acc.id]);

    return {
      id: acc.id,
      name: acc.name,
      platformDisplayName: acc.platform_display_name,
      accountUsername: acc.account_username,
      accountPassword: maskPassword(),
      backendState: acc.backend_state,
      presentationCategory: acc.presentation_category,
      statusDescription: acc.status_description,
      warningMessage: acc.warning_message,
      isSelectable: acc.is_selectable,
      availableActions: acc.available_actions,
      pendingOperation: acc.pending_operation,
      tags: acc.tags || [],
      lastUpdated: acc.updated_at.toISOString(),
      lastSynchronization: acc.last_synchronization.toISOString()
    };
  });
}

/**
 * List paginated and filtered betting accounts for an operator.
 * @param {string} accountId 
 * @param {Object} [options]
 * @param {number} [options.offset]
 * @param {number} [options.limit]
 * @param {string} [options.sortBy]
 * @param {string} [options.filterQuery]
 * @returns {Promise<Object>}
 */
export async function listBettingAccounts(accountId, options = {}) {
  const pool = getPool();
  const offset = Number(options.offset) || 0;
  const limit = Math.min(Number(options.limit) || 50, 100);

  let query = `
    SELECT ba.*, aac.bet_cycle_enabled, aac.browser_status, aac.account_status,
           aac.pricing_source, aac.risk_source, aac.rebet_source
    FROM betting_accounts ba
    LEFT JOIN automation_account_configs aac ON ba.id = aac.account_id
    WHERE ba.account_id = $1
  `;
  const params = [accountId];

  if (options.filterQuery) {
    params.push(`%${options.filterQuery.toLowerCase()}%`);
    query += ` AND (lower(ba.name) LIKE $${params.length} OR lower(ba.account_username) LIKE $${params.length})`;
  }

  query += ` ORDER BY ba.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const res = await pool.query(query, params);
  const countRes = await pool.query('SELECT COUNT(*) FROM betting_accounts WHERE account_id = $1', [accountId]);
  const totalCount = Number(countRes.rows[0].count);

  const viewportAccounts = res.rows.map((acc) => ({
    id: acc.id,
    name: acc.name,
    platformDisplayName: acc.platform_display_name,
    accountUsername: acc.account_username,
    accountPassword: maskPassword(),
    backendState: acc.backend_state,
    presentationCategory: acc.presentation_category,
    statusDescription: acc.status_description,
    warningMessage: acc.warning_message,
    isSelectable: acc.is_selectable,
    availableActions: acc.available_actions || ['ACTIVATE', 'DELETE'],
    pendingOperation: acc.pending_operation,
    tags: acc.tags || [],
    lastUpdated: acc.updated_at.toISOString(),
    lastSynchronization: acc.last_synchronization.toISOString()
  }));

  return {
    viewportAccounts,
    bulkCapabilities: {
      supportedOperations: ['BULK_DELETE', 'BULK_ACTIVATE', 'BULK_DEACTIVATE'],
      maximumSelection: 20,
      requiresConfirmation: true,
      canRunWhileAutomationActive: false
    },
    searchMetadata: {
      totalCount,
      currentFilters: [],
      appliedTags: [],
      savedSearches: [],
      recentSearches: []
    }
  };
}

/**
 * Get detailed account by ID.
 * @param {string} accountId 
 * @param {string} id 
 * @returns {Promise<Object>}
 */
export async function getBettingAccount(accountId, id) {
  const pool = getPool();
  const res = await pool.query(`
    SELECT ba.*, aac.bet_cycle_enabled, aac.browser_status, aac.account_status,
           aac.pricing_source, aac.risk_source, aac.rebet_source,
           aac.custom_pricing, aac.custom_risk, aac.custom_rebet
    FROM betting_accounts ba
    LEFT JOIN automation_account_configs aac ON ba.id = aac.account_id
    WHERE ba.id = $1 AND ba.account_id = $2
  `, [id, accountId]);

  if (res.rows.length === 0) {
    throw new Error('Betting account not found');
  }

  const acc = res.rows[0];
  return {
    id: acc.id,
    name: acc.name,
    platformDisplayName: acc.platform_display_name,
    accountUsername: acc.account_username,
    accountPassword: maskPassword(),
    backendState: acc.backend_state,
    presentationCategory: acc.presentation_category,
    statusDescription: acc.status_description,
    warningMessage: acc.warning_message,
    isSelectable: acc.is_selectable,
    availableActions: acc.available_actions || ['ACTIVATE', 'DELETE'],
    pendingOperation: acc.pending_operation,
    tags: acc.tags || [],
    lastUpdated: acc.updated_at.toISOString(),
    lastSynchronization: acc.last_synchronization.toISOString(),
    automation: {
      betCycleEnabled: acc.bet_cycle_enabled ?? true,
      browserStatus: acc.browser_status || 'STOPPED',
      accountStatus: acc.account_status || 'IDLE',
      pricingSource: acc.pricing_source || 'GLOBAL',
      riskSource: acc.risk_source || 'GLOBAL',
      rebetSource: acc.rebet_source || 'GLOBAL',
      customPricing: acc.custom_pricing,
      customRisk: acc.custom_risk,
      customRebet: acc.custom_rebet
    },
    history: [],
    diagnostics: {
      lastPingMs: 42,
      driverState: 'STANDBY'
    }
  };
}

/**
 * Execute a single action on a betting account.
 * @param {string} accountId 
 * @param {string} id 
 * @param {'ACTIVATE_ACCOUNT' | 'DEACTIVATE_ACCOUNT' | 'ARCHIVE_ACCOUNT' | 'DELETE_ACCOUNT'} actionType 
 * @returns {Promise<Object>}
 */
export async function executeAccountAction(accountId, id, actionType) {
  const pool = getPool();

  if (actionType === 'DELETE_ACCOUNT') {
    const res = await pool.query('DELETE FROM betting_accounts WHERE id = $1 AND account_id = $2 RETURNING id', [id, accountId]);
    if (res.rows.length === 0) throw new Error('Account not found');
    return { success: true, accountId: id, action: 'DELETED' };
  }

  let newState = 'ACTIVE';
  let category = 'Healthy';
  let description = 'Operating normally';

  if (actionType === 'DEACTIVATE_ACCOUNT') {
    newState = 'SUSPENDED';
    category = 'Neutral';
    description = 'Account deactivated by operator';
  } else if (actionType === 'ARCHIVE_ACCOUNT') {
    newState = 'ARCHIVED';
    category = 'Neutral';
    description = 'Account archived';
  }

  const res = await pool.query(`
    UPDATE betting_accounts
    SET backend_state = $1, presentation_category = $2, status_description = $3, updated_at = now()
    WHERE id = $4 AND account_id = $5
    RETURNING id, backend_state
  `, [newState, category, description, id, accountId]);

  if (res.rows.length === 0) throw new Error('Account not found');

  return { success: true, accountId: id, backendState: newState };
}

/**
 * Execute bulk action on an array of betting accounts.
 * @param {string} accountId 
 * @param {'BULK_ACTIVATE' | 'BULK_DEACTIVATE' | 'BULK_DELETE'} actionType 
 * @param {string[]} accountIds 
 * @returns {Promise<Object>}
 */
export async function executeBulkAction(accountId, actionType, accountIds) {
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    throw new Error('accountIds must be a non-empty array');
  }

  const pool = getPool();
  let successful = 0;
  let failed = 0;
  const errors = [];

  for (const id of accountIds) {
    try {
      if (actionType === 'BULK_DELETE') {
        await executeAccountAction(accountId, id, 'DELETE_ACCOUNT');
      } else if (actionType === 'BULK_ACTIVATE') {
        await executeAccountAction(accountId, id, 'ACTIVATE_ACCOUNT');
      } else if (actionType === 'BULK_DEACTIVATE') {
        await executeAccountAction(accountId, id, 'DEACTIVATE_ACCOUNT');
      }
      successful++;
    } catch (e) {
      failed++;
      errors.push({ id, reason: e.message });
    }
  }

  return {
    result: {
      operation: actionType,
      successful,
      failed,
      errors
    }
  };
}

/**
 * Decrypt the stored password for automation runner execution.
 * @param {string} accountId 
 * @param {string} id 
 * @returns {Promise<string>}
 */
export async function getDecryptedPassword(accountId, id) {
  const pool = getPool();
  const res = await pool.query(`
    SELECT platform_display_name, account_username, account_password_encrypted, password_iv, password_tag
    FROM betting_accounts
    WHERE id = $1 AND account_id = $2
  `, [id, accountId]);

  if (res.rows.length === 0) throw new Error('Account not found');
  const { platform_display_name, account_username, account_password_encrypted, password_iv, password_tag } = res.rows[0];

  const aad = Buffer.from(`${accountId}:${platform_display_name}:${account_username}`);
  const decryptedBuf = decrypt(MASTER_VAULT_KEY, password_iv, account_password_encrypted, password_tag, aad);
  return decryptedBuf.toString('utf8');
}

export const getBettingAccountById = getBettingAccount;
