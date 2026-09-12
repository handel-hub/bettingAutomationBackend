// @ts-check
import { validateEnvelope } from '../../protocol/envelope.mjs';
import { useNonce } from '../../protocol/nonce.mjs';
import { getPool } from '../../persistence/connection.mjs';

/**
 * Middleware to validate incoming Protocol Envelopes
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 * @param {import('express').NextFunction} next 
 */
export async function envelopeValidator(req, res, next) {
  try {
    const rawEnvelope = req.body;
    if (!rawEnvelope || typeof rawEnvelope !== 'object') {
      const err = new Error('Invalid envelope structure');
      // @ts-ignore
      err.status = 400;
      // @ts-ignore
      err.code = 'BE_VAL_SCHEMA_VIOLATION';
      // @ts-ignore
      err.legacyCode = 'INVALID_FORMAT';
      throw err;
    }
    
    // We need the machine public key to verify the signature
    // In practice, we look it up by machineId from the envelope
    const { machineId } = rawEnvelope;
    if (!machineId) {
      const err = new Error('Missing machineId in envelope');
      // @ts-ignore
      err.status = 400;
      // @ts-ignore
      err.code = 'BE_VAL_SCHEMA_VIOLATION';
      // @ts-ignore
      err.legacyCode = 'INVALID_FORMAT';
      throw err;
    }
    
    const pool = getPool();
    const machineRes = await pool.query(
      "SELECT machine_id, public_key_hex, status FROM machines WHERE (machine_id::text = $1 OR installation_id = $1 OR descriptor->>'hardwareId' = $1)",
      [machineId]
    );
    if (machineRes.rows.length === 0) {
      const err = new Error('MACHINE_REVOKED');
      // @ts-ignore
      err.status = 403;
      // @ts-ignore
      err.code = 'BE_AUTH_MACHINE_REVOKED';
      // @ts-ignore
      err.legacyCode = 'MACHINE_REVOKED';
      throw err;
    }
    
    const matchedMachine = machineRes.rows[0];
    if (matchedMachine.status === 'REVOKED') {
      const err = new Error('MACHINE_REVOKED');
      // @ts-ignore
      err.status = 403;
      // @ts-ignore
      err.code = 'BE_AUTH_MACHINE_REVOKED';
      // @ts-ignore
      err.legacyCode = 'MACHINE_REVOKED';
      throw err;
    }

    const publicKeyHex = matchedMachine.public_key_hex;
    
    const { valid, envelope, error } = await validateEnvelope(rawEnvelope, publicKeyHex);
    if (!valid) {
      let code = 'BE_AUTH_INVALID_SIGNATURE';
      let legacyCode = error || 'INVALID_SIGNATURE';
      let status = 401;

      if (error === 'NONCE_EXPIRED') {
        code = 'BE_AUTH_NONCE_EXPIRED';
        legacyCode = 'NONCE_EXPIRED';
        status = 400;
      } else if (error === 'UNSUPPORTED_VERSION' || error === 'MISSING_REQUIRED_FIELDS' || error === 'INVALID_FORMAT') {
        code = 'BE_VAL_SCHEMA_VIOLATION';
        legacyCode = 'INVALID_FORMAT';
        status = 400;
      }

      const err = new Error(legacyCode);
      // @ts-ignore
      err.status = status;
      // @ts-ignore
      err.code = code;
      // @ts-ignore
      err.legacyCode = legacyCode;
      throw err;
    }
    
    // Look up accountId from session
    if (envelope.sessionId) {
      const sessRes = await pool.query(
        "SELECT account_id FROM sessions WHERE session_id = $1 AND machine_id = $2 AND status = 'AUTHENTICATED'",
        [envelope.sessionId, matchedMachine.machine_id]
      );
      if (sessRes.rows.length > 0) {
        req.accountId = sessRes.rows[0].account_id;
      }
    }

    // Monotonic generation validation if generation is tracked
    if (envelope.sessionId && req.accountId && typeof envelope.clientGeneration === 'number') {
      const stateRes = await pool.query(
        "SELECT session_generation, machine_generation FROM machine_session_states WHERE account_id = $1 AND machine_id = $2",
        [req.accountId, matchedMachine.machine_id]
      );
      if (stateRes.rows.length > 0) {
        const curGen = Number(stateRes.rows[0].session_generation);
        if (envelope.clientGeneration < curGen) {
          const genErr = new Error('GENERATION_MISMATCH');
          // @ts-ignore
          genErr.status = 409;
          // @ts-ignore
          genErr.code = 'BE_REV_GENERATION_MISMATCH';
          // @ts-ignore
          genErr.legacyCode = 'GENERATION_MISMATCH';
          throw genErr;
        }
      }
    }
    
    // Check nonce replay (single-use nonces)
    await useNonce(envelope.nonce, envelope.clientServerEpoch);
    
    req.envelope = envelope;
    req.machineId = matchedMachine.machine_id;
    req.sessionId = envelope.sessionId;
    
    // Unwrap payload if object so downstream route handlers can read req.body transparently
    if (envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)) {
      req.body = { ...envelope.payload };
    }
    
    next();
  } catch (err) {
    next(err);
  }
}
