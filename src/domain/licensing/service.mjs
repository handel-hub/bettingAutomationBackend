// @ts-check
import { findActiveByAccount } from './repository.mjs';
import { getPool } from '../../persistence/connection.mjs';
import { canonicalStringify } from '../../protocol/canonical.mjs';
import { signWithActiveKey } from '../../crypto/keys.mjs';

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

/**
 * Cryptographically sign a license payload using the Backend's active Ed25519 KMS key
 * over RFC 8785 canonical JSON.
 * @param {Record<string, any>} licensePayload
 * @returns {Promise<Record<string, any>>}
 */
export async function signLicensePayload(licensePayload) {
  if (!licensePayload || typeof licensePayload !== 'object') {
    return licensePayload;
  }
  const claims = { ...licensePayload };
  delete claims.signature;
  delete claims.key_version;
  delete claims.keyVersion;

  const canonicalString = canonicalStringify(claims);
  const messageBuffer = Buffer.from(canonicalString, 'utf8');
  const { signatureHex, keyVersion } = await signWithActiveKey(messageBuffer);

  return {
    ...claims,
    key_version: keyVersion,
    signature: signatureHex
  };
}

/**
 * Assert that a registered operator account possesses an active, non-expired VALID license.
 * Throws 403 BE_PERM_LICENSE_EXPIRED if the account's license is missing, expired, or revoked.
 * @param {import('pg').PoolClient | import('pg').Pool | null | undefined} client
 * @param {string} accountId
 * @param {string | null} [requiredCapability]
 * @returns {Promise<any>}
 */
export async function assertActiveLicense(client, accountId, requiredCapability = null) {
  if (!accountId) {
    const err = new Error('Account ID is required');
    // @ts-ignore
    err.status = 401;
    // @ts-ignore
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  const runner = client || getPool();
  const activeLic = await findActiveByAccount(runner, accountId);
  if (activeLic) {
    if (requiredCapability) {
      const caps = Array.isArray(activeLic.capabilities) ? activeLic.capabilities : [];
      if (caps.length > 0 && !caps.includes(requiredCapability)) {
        const err = new Error(`License lacks required capability: ${requiredCapability}`);
        // @ts-ignore
        err.status = 403;
        // @ts-ignore
        err.code = 'BE_PERM_ENTITLEMENT_EXCEEDED';
        throw err;
      }
    }
    return activeLic;
  }

  // Check if this accountId exists in accounts or licenses table
  const checkRes = await runner.query(
    `SELECT
       EXISTS(SELECT 1 FROM accounts WHERE account_id = $1) AS has_account,
       EXISTS(SELECT 1 FROM licenses WHERE account_id = $1) AS has_any_license`,
    [accountId]
  );
  const { has_account: hasAccount, has_any_license: hasAnyLicense } = checkRes.rows[0] || {};

  if (hasAccount || hasAnyLicense) {
    const err = new Error('Active valid license required to perform this operation');
    // @ts-ignore
    err.status = 403;
    // @ts-ignore
    err.code = 'BE_PERM_LICENSE_EXPIRED';
    throw err;
  }

  return null;
}

