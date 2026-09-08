// @ts-check
import { sha256 } from '../crypto/hashing.mjs';
import { verify, sign } from '../crypto/ed25519.mjs';
import { getActiveKey, getKeyByVersion } from '../crypto/keys.mjs';
import { getKmsAdapter } from '../crypto/kms-adapter.mjs';
import { canonicalStringify } from './canonical.mjs';

/**
 * Validates a protocol envelope.
 * @param {Object} raw 
 * @param {string} machinePublicKeyHex
 * @returns {Promise<{ valid: boolean; envelope?: any; error?: string }>}
 */
export async function validateEnvelope(raw, machinePublicKeyHex) {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Invalid format' };
  }
  
  if (raw.version !== 2) {
    if (raw.version === 1) {
      // V1 compat path would go here, skipping timestamp/server_epoch
      // We'll enforce v2 for now unless explicitly downgraded.
    } else {
      return { valid: false, error: 'Unsupported version' };
    }
  }
  
  const { signature, payload, nonce, timestamp, clientGeneration, clientServerEpoch, sessionId, machineId } = raw;
  
  if (!signature || !payload || !nonce) {
    return { valid: false, error: 'Missing required fields' };
  }
  
  // Verify timestamp is within 30s
  if (timestamp) {
    const ts = new Date(timestamp).getTime();
    if (Math.abs(Date.now() - ts) > 30000) {
      return { valid: false, error: 'NONCE_EXPIRED' }; // CRIT-06 fix
    }
  }

  // To verify signature, we construct canonical representation of envelope without signature
  const envelopeToSign = {
    version: raw.version,
    sessionId,
    machineId,
    nonce,
    timestamp,
    clientGeneration,
    clientServerEpoch,
    payload
  };
  
  const canonicalString = canonicalStringify(envelopeToSign);
  const messageBuffer = Buffer.from(canonicalString, 'utf8');
  
  const publicKey = Buffer.from(machinePublicKeyHex, 'hex');
  
  const isValid = verify(publicKey, messageBuffer, signature);
  if (!isValid) {
    return { valid: false, error: 'Invalid signature' };
  }
  
  return { valid: true, envelope: raw };
}

/**
 * Build an envelope to send to the client.
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
    server_epoch: serverEpoch,
    payload,
    generation
  };
  
  const canonicalString = canonicalStringify(envelope);
  const messageBuffer = Buffer.from(canonicalString, 'utf8');
  const signatureHex = sign(privateKey, messageBuffer);
  
  return {
    ...envelope,
    signatures: {
      [activeKeyInfo.key_version]: signatureHex
    }
  };
}
