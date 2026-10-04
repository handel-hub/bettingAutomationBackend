// @ts-check
import { withTransaction } from '../../persistence/transaction.mjs';
import { encrypt, decrypt } from '../../crypto/aead.mjs';
import crypto from 'crypto';
import {
  insertAccount,
  findAccountsByAccount,
  countAccountsByAccount,
  findAccountById,
  deleteAccount,
  updateAccountState,
  updateAccountFields,
  getCredentialsForDecryption
} from './repository.mjs';

/**
 * Master key for AEAD AES-256-GCM encryption of stored betting passwords.
 * Fails closed in production if KMS_LOCAL_SECRET is not set.
 */
function getMasterVaultKey() {
  const secret = process.env.KMS_LOCAL_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: KMS_LOCAL_SECRET environment variable is required in production');
    }
    return crypto.createHash('sha256').update('betting_automation_master_vault_key_32').digest();
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * @typedef {Object} AccountActionContract
 * @property {string} id
 * @property {string} label
 * @property {string} icon
 * @property {boolean} disabled
 * @property {string | null} disabledReason
 * @property {'default' | 'primary' | 'danger' | 'warning'} variant
 */

/**
 * Format server-driven action buttons according to Contract Section 7 & 8.1
 * @param {string[] | Object[]} [rawActions]
 * @param {string} [backendState]
 * @returns {AccountActionContract[]}
 */
export function formatAccountActions(rawActions, backendState = 'ACTIVE') {
  if (Array.isArray(rawActions) && rawActions.length > 0 && typeof rawActions[0] === 'object' && rawActions[0].id) {
    // @ts-ignore
    return rawActions;
  }

  /** @type {AccountActionContract[]} */
  const actions = [];
  if (backendState === 'ACTIVE') {
    actions.push({
      id: 'DEACTIVATE_ACCOUNT',
      label: 'Deactivate Account',
      icon: 'pause',
      disabled: false,
      disabledReason: null,
      variant: 'warning'
    });
  } else {
    actions.push({
      id: 'ACTIVATE_ACCOUNT',
      label: 'Activate Account',
      icon: 'play',
      disabled: false,
      disabledReason: null,
      variant: 'primary'
    });
  }

  actions.push({
    id: 'EDIT_CREDENTIALS',
    label: 'Edit Credentials',
    icon: 'edit',
    disabled: false,
    disabledReason: null,
    variant: 'default'
  });

  actions.push({
    id: 'DELETE_ACCOUNT',
    label: 'Delete Account',
    icon: 'trash-2',
    disabled: false,
    disabledReason: null,
    variant: 'danger'
  });

  return actions;
}

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
  const { id, name, platformDisplayName, accountUsername, accountPassword, tags = [] } = data;

  if (!platformDisplayName || !accountUsername || !accountPassword) {
    throw new Error('Platform, username, and password are required');
  }

  // Encrypt password using AES-256-GCM
  const aad = Buffer.from(`${accountId}:${platformDisplayName}:${accountUsername}`);
  const { nonce, ciphertext, tag } = encrypt(getMasterVaultKey(), Buffer.from(accountPassword, 'utf8'), aad);

  return withTransaction('READ COMMITTED', async (client) => {
    const acc = await insertAccount(client, {
      id,
      accountId,
      name: name || `${platformDisplayName} - ${accountUsername}`,
      platformDisplayName,
      accountUsername,
      ciphertext,
      nonce,
      tag,
      tags
    });

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
      availableActions: formatAccountActions(acc.available_actions, acc.backend_state),
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
  const rows = await findAccountsByAccount(undefined, accountId, options);
  const totalCount = await countAccountsByAccount(undefined, accountId);

  const viewportAccounts = rows.map((acc) => ({
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
    availableActions: formatAccountActions(acc.available_actions, acc.backend_state),
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
  const acc = await findAccountById(undefined, accountId, id);

  if (!acc) {
    throw new Error('Betting account not found');
  }
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
    availableActions: formatAccountActions(acc.available_actions, acc.backend_state),
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
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(id)) {
    const err = new Error(`Invalid account ID format: expected UUID, received "${id}"`);
    // @ts-ignore
    err.code = 'BE_VAL_INVALID_UUID';
    // @ts-ignore
    err.status = 400;
    throw err;
  }

  if (actionType === 'DELETE_ACCOUNT' || actionType === 'DELETE') {
    const res = await deleteAccount(undefined, accountId, id);
    if (!res) throw new Error('Account not found');
    return { success: true, accountId: id, action: 'DELETED', backendState: 'DELETED', presentationCategory: 'Neutral', statusDescription: 'Account deleted' };
  }

  let newState = 'ACTIVE';
  let category = 'Healthy';
  let description = 'Operating normally';

  if (actionType === 'DEACTIVATE_ACCOUNT' || actionType === 'DEACTIVATE') {
    newState = 'SUSPENDED';
    category = 'Neutral';
    description = 'Account deactivated by operator';
  } else if (actionType === 'ARCHIVE_ACCOUNT' || actionType === 'ARCHIVE') {
    newState = 'ARCHIVED';
    category = 'Neutral';
    description = 'Account archived';
  } else if (actionType === 'ACTIVATE_ACCOUNT' || actionType === 'ACTIVATE') {
    newState = 'ACTIVE';
    category = 'Healthy';
    description = 'Operating normally';
  }

  const res = await updateAccountState(undefined, accountId, id, { newState, category, description });
  if (!res) throw new Error('Account not found');

  return {
    success: true,
    accountId: id,
    backendState: newState,
    presentationCategory: category,
    statusDescription: description
  };
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
  const creds = await getCredentialsForDecryption(undefined, accountId, id);
  if (!creds) throw new Error('Account not found');
  const { platform_display_name, account_username, account_password_encrypted, password_iv, password_tag } = creds;

  const aad = Buffer.from(`${accountId}:${platform_display_name}:${account_username}`);
  const decryptedBuf = decrypt(getMasterVaultKey(), password_iv, account_password_encrypted, password_tag, aad);
  return decryptedBuf.toString('utf8');
}

export async function updateBettingAccount(accountId, id, updates) {
  let ciphertext, nonce, tag;
  if (updates.accountPassword) {
    const existing = await findAccountById(undefined, accountId, id);
    if (!existing) throw new Error('Betting account not found');
    const aad = Buffer.from(`${accountId}:${existing.platform_display_name}:${existing.account_username}`);
    const encrypted = encrypt(getMasterVaultKey(), Buffer.from(updates.accountPassword, 'utf8'), aad);
    ciphertext = encrypted.ciphertext;
    nonce = encrypted.nonce;
    tag = encrypted.tag;
  }

  const updated = await updateAccountFields(undefined, accountId, id, {
    name: updates.name,
    ciphertext,
    nonce,
    tag,
    tags: updates.tags
  });

  if (!updated) throw new Error('Betting account not found');

  return {
    id: updated.id,
    name: updated.name,
    platformDisplayName: updated.platform_display_name,
    accountUsername: updated.account_username,
    accountPassword: maskPassword(),
    backendState: updated.backend_state,
    presentationCategory: updated.presentation_category,
    statusDescription: updated.status_description,
    warningMessage: updated.warning_message,
    isSelectable: updated.is_selectable,
    availableActions: formatAccountActions(updated.available_actions, updated.backend_state),
    pendingOperation: updated.pending_operation,
    tags: updated.tags || [],
    lastUpdated: updated.updated_at.toISOString(),
    lastSynchronization: updated.last_synchronization ? updated.last_synchronization.toISOString() : new Date().toISOString()
  };
}

export const getBettingAccountById = getBettingAccount;
