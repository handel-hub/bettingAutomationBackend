// @ts-check
import { findById } from '../account/repository.mjs';
import { findLatestByAccount } from '../licensing/repository.mjs';
import { getBillingSnapshot } from '../billing/service.mjs';
import { getPlatformRegistrySnapshot } from '../platforms/service.mjs';
import { getCustomerCareSnapshot } from '../support/service.mjs';
import { getAutomationSnapshot } from '../automation/service.mjs';

/**
 * Composite business state aggregation for initial console load (CNT-PRELUDE-01).
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function getPreludeSnapshot(accountId) {
  // 1. Fetch Account & Profile
  const accRow = await findById(undefined, accountId);
  const account = accRow ? {
    id: accRow.account_id,
    email: accRow.email,
    status: accRow.status,
    createdAt: accRow.created_at
  } : null;

  // 2. Fetch Active License
  const licRow = await findLatestByAccount(undefined, accountId);
  const license = licRow ? {
    id: licRow.license_id,
    planId: licRow.plan_id,
    status: licRow.status,
    capabilities: licRow.capabilities,
    limits: licRow.limits,
    issuedAt: licRow.issued_at,
    expiresAt: licRow.expires_at
  } : null;

  // 3. Parallel domain aggregations
  const [billing, platforms, support, automation] = await Promise.all([
    getBillingSnapshot(accountId),
    getPlatformRegistrySnapshot(),
    getCustomerCareSnapshot(accountId),
    getAutomationSnapshot(accountId)
  ]);

  return {
    account,
    license,
    billing,
    platforms,
    support,
    automation,
    timestamp: new Date().toISOString()
  };
}
