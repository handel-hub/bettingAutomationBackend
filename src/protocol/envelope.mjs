// @ts-check
import { verify, sign } from '../crypto/ed25519.mjs';
import { getActiveKey, getKeyByVersion } from '../crypto/keys.mjs';
import { getKmsAdapter } from '../crypto/kms-adapter.mjs';
import { serializeClientRequest, serializeBackendResponse } from './canonical.mjs';

/**
 * Validates an incoming client request Protocol Envelope.
 * @param {Object} raw 
 * @param {string} machinePublicKeyHex
 * @returns {Promise<{ valid: boolean; envelope?: any; error?: string }>}
 */
export async function validateEnvelope(raw, machinePublicKeyHex) {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'INVALID_FORMAT' };
  }
  
  const version = raw.version ?? raw.v;
  if (version !== 2) {
    return { valid: false, error: 'UNSUPPORTED_VERSION' };
  }
  
  const { nonce, timestamp, payload } = raw;
  const signature = raw.signature || (raw.signatures && (raw.signatures['1'] || raw.signatures['2'] || raw.signatures['v1'] || raw.signatures['v2']));
  
  if (!signature || payload === undefined || !nonce) {
    return { valid: false, error: 'MISSING_REQUIRED_FIELDS' };
  }
  
  // Verify timestamp freshness: must be within 30s (±30,000ms)
  if (!timestamp) {
    return { valid: false, error: 'NONCE_EXPIRED' };
  }
  const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  if (isNaN(ts) || Math.abs(Date.now() - ts) > 30000) {
    return { valid: false, error: 'NONCE_EXPIRED' };
  }

  let pubKeyHex = machinePublicKeyHex;
  let matchedMachine = null;
  if (!pubKeyHex && raw.machineId) {
    const { getPool } = await import('../persistence/connection.mjs');
    const pool = getPool();
    const machineRes = await pool.query(
      "SELECT machine_id, public_key_hex FROM machines WHERE (machine_id::text = $1 OR installation_id = $1 OR descriptor->>'hardwareId' = $1) AND status != 'REVOKED'",
      [raw.machineId]
    );
    if (machineRes.rows.length > 0) {
      pubKeyHex = machineRes.rows[0].public_key_hex;
      matchedMachine = machineRes.rows[0];
    }
  }

  if (!pubKeyHex) {
    return { valid: false, isValid: false, error: 'MACHINE_NOT_FOUND' };
  }

  // Canonicalize client request envelope matching CP CanonicalSerializer.serializeClientRequest
  const messageBuffer = serializeClientRequest(raw);
  const domainPrefix = Buffer.from('CONTROL_PLANE_V1', 'utf8');
  const domainSeparated = Buffer.concat([domainPrefix, messageBuffer]);
  const publicKey = Buffer.from(pubKeyHex, 'hex');
  
  // Support both CONTROL_PLANE_V1 domain separated and raw canonical signatures
  const isValid = verify(publicKey, domainSeparated, signature) || verify(publicKey, messageBuffer, signature);
  if (!isValid) {
    return { valid: false, isValid: false, error: 'INVALID_SIGNATURE' };
  }
  
  return { valid: true, isValid: true, envelope: raw, machine: matchedMachine };
}

/**
 * Build a signed response envelope to send to the client.
 * Matches Control Plane EnvelopeValidator verification format.
 * 
 * @param {any} payload 
 * @param {any} generation 
 * @param {number} [serverEpoch=1]
 * @returns {Promise<any>}
 */
export async function buildEnvelope(payload, generation, serverEpoch = 1) {
  const activeKeyInfo = await getActiveKey();
  const kms = getKmsAdapter();
  const privateKey = await kms.getPrivateKey(activeKeyInfo.key_id);
  
  const envelope = {
    version: 2,
    timestamp: new Date().toISOString(),
    server_epoch: Number(serverEpoch),
    payload,
    generation: Number(generation)
  };
  
  const messageBuffer = serializeBackendResponse(envelope);
  const signatureHex = sign(privateKey, messageBuffer);
  
  return {
    ...envelope,
    signatures: {
      [String(activeKeyInfo.key_version || '1')]: signatureHex
    }
  };
}
