// @ts-check
import { getActiveKey, signWithActiveKey } from '../../crypto/keys.mjs';

const TIER_TTL_HOURS = {
  HIGH_RISK: 4,
  MEDIUM_RISK: 24,
  LOW_RISK: 72
};

/**
 * Issue a signed GraceToken for offline use.
 * @param {string} accountId 
 * @param {string} machineId 
 * @param {any} capabilities 
 * @param {string} riskTier 
 * @returns {Promise<any>}
 */
export async function issueGraceToken(accountId, machineId, capabilities, riskTier) {
  const ttlHours = TIER_TTL_HOURS[riskTier] || 24;
  
  const tokenPayload = {
    account_id: accountId,
    machine_id: machineId,
    capabilities,
    issued_at: new Date().toISOString(),
    not_after: new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString()
    // max_offline_budget_ms removed per Freeze Audit P1-5
  };
  
  const canonicalString = JSON.stringify(tokenPayload, Object.keys(tokenPayload).sort());
  const messageBuffer = Buffer.from(canonicalString, 'utf8');
  
  const { signatureHex, keyVersion } = await signWithActiveKey(messageBuffer);
  
  return {
    ...tokenPayload,
    signature: signatureHex,
    key_version: keyVersion
  };
}
