// @ts-check

/**
 * Recursively sort object keys alphabetically while preserving primitives, nulls, and arrays.
 * Conforms to deterministic RFC 8785 (JSON Canonicalization Scheme) principles.
 * 
 * @param {any} value
 * @returns {any}
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  
  if (value instanceof Date) {
    return value.toISOString();
  }
  
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  
  const sortedKeys = Object.keys(value).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(value[key]);
  }
  return result;
}

/**
 * Returns a canonicalized deterministic JSON string representation of any object or array.
 * 
 * @param {any} value 
 * @returns {string}
 */
export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * Serializes an outbound/inbound client request ProtocolEnvelopeV2 for Ed25519 signing/verification.
 * Strict RFC 8785 canonical keys.
 * 
 * @param {Object} envelope 
 * @returns {Buffer}
 */
export function serializeClientRequest(envelope) {
  const envelopeToSign = {
    version: envelope.version ?? 2,
    sessionId: envelope.sessionId || '',
    machineId: envelope.machineId,
    nonce: envelope.nonce,
    timestamp: envelope.timestamp,
    clientGeneration: Number(envelope.clientGeneration ?? 1),
    clientServerEpoch: Number(envelope.clientServerEpoch ?? 1),
    payload: envelope.payload
  };
  return Buffer.from(canonicalStringify(envelopeToSign), 'utf8');
}

/**
 * Serializes an outbound Backend response ProtocolEnvelopeV2 for Ed25519 signing.
 * 
 * @param {Object} envelope 
 * @returns {Buffer}
 */
export function serializeBackendResponse(envelope) {
  const envelopeToSign = {
    version: envelope.version ?? envelope.v ?? 2,
    timestamp: envelope.timestamp,
    server_epoch: Number(envelope.server_epoch ?? envelope.epoch ?? 1),
    payload: envelope.payload,
    generation: Number(envelope.generation ?? 1)
  };
  return Buffer.from(canonicalStringify(envelopeToSign), 'utf8');
}
