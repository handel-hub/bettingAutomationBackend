// @ts-check
import { findActiveByAccount } from './repository.mjs';

/**
 * Get active license capabilities for an account
 * @param {import('pg').PoolClient} client
 * @param {string} accountId 
 * @param {string} machineId 
 * @returns {Promise<any>}
 */
export async function getActiveLicenseForAuth(client, accountId, machineId) {
  return findActiveByAccount(client, accountId);
}
