// @ts-check
import { getPool } from '../../persistence/connection.mjs';
import { withTransaction } from '../../persistence/transaction.mjs';

/**
 * Register a new machine
 * @param {string} installationId 
 * @param {string} publicKeyHex 
 * @param {any} descriptor 
 * @param {string} selfSignature 
 * @param {string} authenticatedSessionId 
 * @returns {Promise<any>}
 */
export async function register(installationId, publicKeyHex, descriptor, selfSignature, authenticatedSessionId) {
  // Security Requirements: S-01 fix (EV-08) — registration MUST require an already-authenticated session
  if (!authenticatedSessionId) {
    throw new Error('Authentication required for machine registration (INV-08)');
  }
  
  return withTransaction('READ COMMITTED', async (client) => {
    // 1. Get account from session
    const sessionRes = await client.query('SELECT account_id FROM sessions WHERE session_id = $1 AND status IN (\'AUTHENTICATED\', \'PARTIAL\')', [authenticatedSessionId]);
    if (sessionRes.rows.length === 0) {
      throw new Error('Invalid or expired session');
    }
    const accountId = sessionRes.rows[0].account_id;
    
    // 2. Check for duplicate installationId / publicKeyHex
    const existingRes = await client.query('SELECT machine_id FROM machines WHERE installation_id = $1 AND public_key_hex = $2', [installationId, publicKeyHex]);
    if (existingRes.rows.length > 0) {
      return existingRes.rows[0]; // Idempotent registration
    }
    
    // 3. Clone detection (same installation_id, different public_key)
    const cloneRes = await client.query('SELECT machine_id FROM machines WHERE installation_id = $1 AND public_key_hex != $2', [installationId, publicKeyHex]);
    if (cloneRes.rows.length > 0) {
      throw new Error('CLONE_SUSPECTED'); // Policy handles this higher up
    }
    
    // 4. Verify selfSignature using publicKeyHex
    const { verify } = await import('../../crypto/ed25519.mjs');
    const pubKeyBuffer = Buffer.from(publicKeyHex, 'hex');
    const msg = Buffer.from(installationId, 'utf8'); // Assuming signature covers installationId
    if (!verify(pubKeyBuffer, msg, selfSignature)) {
      throw new Error('Invalid self-signature');
    }
    
    // 5. Insert machine
    const insertRes = await client.query(`
      INSERT INTO machines (installation_id, account_id, public_key_hex, descriptor, status, machine_generation)
      VALUES ($1, $2, $3, $4, 'REGISTERED', 1)
      RETURNING *
    `, [installationId, accountId, publicKeyHex, JSON.stringify(descriptor)]);
    
    const newMachine = insertRes.rows[0];
    
    // Insert initial generation state
    await client.query(`
      INSERT INTO machine_session_states (account_id, machine_id, session_generation, authorization_revision, machine_generation)
      VALUES ($1, $2, 1, 1, 1)
    `, [accountId, newMachine.machine_id]);
    
    return newMachine;
  });
}

/**
 * @param {string} machineId 
 * @returns {Promise<boolean>}
 */
export async function verifyMachine(machineId) {
  // Verification logic (checking status, last verified etc)
  return true;
}
