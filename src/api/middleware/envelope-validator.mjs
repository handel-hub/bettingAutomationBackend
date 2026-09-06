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
    
    // We need the machine public key to verify the signature
    // In practice, we look it up by machineId from the envelope
    const { machineId } = rawEnvelope;
    if (!machineId) {
      throw new Error('Missing machineId in envelope');
    }
    
    const pool = getPool();
    const machineRes = await pool.query('SELECT public_key_hex FROM machines WHERE machine_id = $1 AND status != \'REVOKED\'', [machineId]);
    if (machineRes.rows.length === 0) {
      res.status(401);
      throw new Error('Machine not found or revoked');
    }
    
    const publicKeyHex = machineRes.rows[0].public_key_hex;
    
    const { valid, envelope, error } = await validateEnvelope(rawEnvelope, publicKeyHex);
    if (!valid) {
      res.status(400);
      throw new Error(`Envelope validation failed: ${error}`);
    }
    
    // Check nonce replay
    await useNonce(envelope.nonce, envelope.clientServerEpoch);
    
    req.envelope = envelope;
    next();
  } catch (err) {
    next(err);
  }
}
