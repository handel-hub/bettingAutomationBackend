// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Fetch system version status and available updates.
 * @returns {Promise<Object>}
 */
export async function getSystemVersionInfo() {
  const pool = getPool();
  const res = await pool.query('SELECT * FROM system_versions ORDER BY created_at ASC');

  let currentVersion = 'v0.1.0-alpha';
  let availableVersion = 'v0.2.0';
  let hasUpdateDownloaded = false;

  for (const row of res.rows) {
    if (row.is_current) {
      currentVersion = row.version_id;
    }
    if (row.is_available) {
      availableVersion = row.version_id;
      hasUpdateDownloaded = true;
    }
  }

  return {
    currentVersion,
    hasUpdateDownloaded,
    availableVersion
  };
}

/**
 * Process a system restart and update intent.
 * @param {string} accountId 
 * @param {Object} intent 
 * @param {string} intent.targetVersion 
 * @returns {Promise<Object>}
 */
export async function restartAndUpdate(accountId, intent) {
  const { targetVersion } = intent;

  // In real execution, sends SIGUSR2 or triggers supervisor process reload
  console.log(`[SYSTEM] Dispatched restart and update intent for ${targetVersion} by operator ${accountId}`);

  return {
    status: 'ACCEPTED',
    message: `Control Plane accepted restart request for ${targetVersion || 'v0.2.0'}.`
  };
}
