import { getActiveKey, signWithActiveKey } from '../../crypto/keys.mjs';
import { canonicalStringify } from '../../protocol/canonical.mjs';
import { verify } from '../../crypto/ed25519.mjs';

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
  const now = Date.now();
  const notAfter = now + ttlHours * 60 * 60 * 1000;
  
  const tokenPayload = {
    account_id: accountId,
    machine_id: machineId,
    capabilities,
    issued_at: now,
    not_before: now,
    not_after: notAfter
  };
  
  const canonicalString = canonicalStringify(tokenPayload);
  const messageBuffer = Buffer.from(canonicalString, 'utf8');
  
  const { signatureHex, keyVersion } = await signWithActiveKey(messageBuffer);
  
  return {
    ...tokenPayload,
    signature: signatureHex,
    key_version: keyVersion
  };
}

/**
 * Verify a GraceToken offline
 * @param {Object} token 
 * @param {string|Buffer} backendPublicKey 
 * @returns {boolean}
 */
export function verifyGraceToken(token, backendPublicKey) {
  if (!token || !token.signature) return false;
  
  const now = Date.now();
  if (token.not_before && now < Number(token.not_before)) return false;
  if (token.not_after && now > Number(token.not_after)) return false;

  const { signature, key_version, ...tokenPayload } = token;
  const canonicalString = canonicalStringify(tokenPayload);
  const messageBuffer = Buffer.from(canonicalString, 'utf8');
  const pubKey = typeof backendPublicKey === 'string' ? Buffer.from(backendPublicKey, 'hex') : backendPublicKey;

  return verify(pubKey, messageBuffer, signature);
}
