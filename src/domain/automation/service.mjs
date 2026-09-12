// @ts-check
import { getPool } from '../../persistence/connection.mjs';
import crypto from 'crypto';

/**
 * Compile the full AutomationWorkspaceSnapshot for an operator.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function getAutomationSnapshot(accountId) {
  const pool = getPool();

  // 1. Fetch Global Config
  const configRes = await pool.query('SELECT * FROM global_automation_configs WHERE id = $1', ['primary']);
  const globalConfigRow = configRes.rows[0] || {};

  // 2. Fetch Active License & Capabilities
  const licenseRes = await pool.query(`
    SELECT capabilities, limits FROM licenses
    WHERE account_id = $1 AND status = 'VALID'
    ORDER BY issued_at DESC LIMIT 1
  `, [accountId]);
  const license = licenseRes.rows[0];
  const licenseCaps = Array.isArray(license?.capabilities) ? license.capabilities : [];
  const maxBrowsers = license?.limits?.max_concurrent_browsers || 2;

  // 3. Fetch Accounts with Automation Settings
  const accountsRes = await pool.query(`
    SELECT ba.id, ba.name, ba.platform_display_name, ba.account_username,
           ba.backend_state, aac.bet_cycle_enabled, aac.browser_status, aac.account_status,
           aac.pricing_source, aac.risk_source, aac.rebet_source,
           aac.custom_pricing, aac.custom_risk, aac.custom_rebet
    FROM betting_accounts ba
    LEFT JOIN automation_account_configs aac ON ba.id = aac.account_id
    WHERE ba.account_id = $1
    ORDER BY ba.created_at ASC
  `, [accountId]);

  const accounts = accountsRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    platformDisplayName: r.platform_display_name,
    accountUsername: r.account_username,
    backendState: r.backend_state,
    betCycleEnabled: r.bet_cycle_enabled ?? true,
    pricingSource: r.pricing_source || 'GLOBAL',
    riskSource: r.risk_source || 'GLOBAL',
    rebetSource: r.rebet_source || 'GLOBAL',
    customPricing: r.custom_pricing,
    customRisk: r.custom_risk,
    customRebet: r.custom_rebet
  }));

  return {
    globalConfig: {
      pricing: globalConfigRow.pricing || {},
      risk: globalConfigRow.risk || {},
      rebet: globalConfigRow.rebet || {},
      proxy: globalConfigRow.proxy || {},
      execution: globalConfigRow.execution || {},
      browserSpawning: globalConfigRow.browser_spawning || {},
      advancedRuntime: globalConfigRow.advanced_runtime || {}
    },
    accounts,
    serverLimits: {
      maxConcurrentBrowsers: maxBrowsers,
      allowedPlatforms: license?.limits?.allowedPlatforms || []
    }
  };
}

/**
 * Update a global config category (pricing, risk, rebet, etc.)
 * @param {string} accountId 
 * @param {string} category 
 * @param {Object} values 
 * @returns {Promise<Object>}
 */
export async function updateGlobalConfig(accountId, category, values) {
  const validColumns = {
    pricing: 'pricing',
    risk: 'risk',
    rebet: 'rebet',
    proxy: 'proxy',
    execution: 'execution',
    browserSpawning: 'browser_spawning',
    browser_spawning: 'browser_spawning',
    advancedRuntime: 'advanced_runtime',
    advanced_runtime: 'advanced_runtime'
  };

  const col = validColumns[category];
  if (!col) throw new Error(`Invalid configuration category: ${category}`);

  const pool = getPool();
  const res = await pool.query(`
    UPDATE global_automation_configs
    SET ${col} = ${col} || $1::jsonb, updated_at = now()
    WHERE id = 'primary'
    RETURNING *
  `, [JSON.stringify(values)]);

  const updated = res.rows[0];
  return {
    success: true,
    globalConfig: {
      pricing: updated.pricing,
      risk: updated.risk,
      rebet: updated.rebet,
      proxy: updated.proxy,
      execution: updated.execution,
      browserSpawning: updated.browser_spawning,
      advancedRuntime: updated.advanced_runtime
    }
  };
}

/**
 * Toggle bet cycle participation for an account.
 * @param {string} accountId 
 * @param {string} bettingAccountId 
 * @param {boolean} enabled 
 * @returns {Promise<Object>}
 */
export async function toggleBetCycle(accountId, bettingAccountId, enabled) {
  const pool = getPool();
  await pool.query(`
    UPDATE automation_account_configs
    SET bet_cycle_enabled = $1, updated_at = now()
    WHERE account_id = (SELECT id FROM betting_accounts WHERE id = $2 AND account_id = $3)
  `, [enabled, bettingAccountId, accountId]);

  return { accountId: bettingAccountId, betCycleEnabled: enabled };
}

/**
 * Apply per-account custom overrides.
 * @param {string} accountId 
 * @param {string} bettingAccountId 
 * @param {'pricing' | 'risk' | 'rebet'} category 
 * @param {'GLOBAL' | 'CUSTOM'} source 
 * @param {Object} values 
 * @returns {Promise<Object>}
 */
export async function updateAccountAutomationConfig(accountId, bettingAccountId, category, source, values) {
  const colSource = `${category}_source`;
  const colCustom = `custom_${category}`;

  const pool = getPool();
  const res = await pool.query(`
    UPDATE automation_account_configs
    SET ${colSource} = $1, ${colCustom} = $2, updated_at = now()
    WHERE account_id = (SELECT id FROM betting_accounts WHERE id = $3 AND account_id = $4)
    RETURNING *
  `, [source, JSON.stringify(values), bettingAccountId, accountId]);

  if (res.rows.length === 0) throw new Error('Account not found');
  return { success: true, account: res.rows[0] };
}
