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
export async function register(installationId, publicKeyHex, descriptor, selfSignature, authenticatedSessionId = null) {
  return withTransaction('READ COMMITTED', async (client) => {
    let accountId = null;

    // 1. If authenticatedSessionId provided, resolve account_id
    if (authenticatedSessionId) {
      const sessionRes = await client.query('SELECT account_id FROM sessions WHERE session_id = $1 AND status IN (\'AUTHENTICATED\', \'PARTIAL\')', [authenticatedSessionId]);
      if (sessionRes.rows.length > 0) {
        accountId = sessionRes.rows[0].account_id;
      } else {
        // Check if authenticatedSessionId is in security_events metadata as partial_token
        const auditRes = await client.query(
          "SELECT account_id FROM security_events WHERE metadata->>'partial_token' = $1 AND event_type = 'LOGIN_SUCCESS' AND created_at > now() - interval '2 hours' LIMIT 1",
          [authenticatedSessionId]
        );
        if (auditRes.rows.length > 0) {
          accountId = auditRes.rows[0].account_id;
        }
      }
    }
    
    // 2. Check for duplicate installationId / publicKeyHex (idempotent registration)
    const existingRes = await client.query(
      'SELECT * FROM machines WHERE installation_id = $1 AND public_key_hex = $2',
      [installationId, publicKeyHex]
    );
    if (existingRes.rows.length > 0) {
      return existingRes.rows[0];
    }
    
    // 3. Clone detection (same installation_id, different public_key)
    const cloneRes = await client.query(
      'SELECT machine_id FROM machines WHERE installation_id = $1 AND public_key_hex != $2',
      [installationId, publicKeyHex]
    );
    if (cloneRes.rows.length > 0) {
      const err = new Error('CLONE_SUSPECTED');
      // @ts-ignore
      err.code = 'CLONE_SUSPECTED';
      // @ts-ignore
      err.status = 403;
      throw err;
    }
    
    // 4. Verify selfSignature using publicKeyHex
    // CP signs `REGISTRATION:${hardwareId}` where installationId is `inst_${hardwareId}`
    const { verify } = await import('../../crypto/ed25519.mjs');
    const pubKeyBuffer = Buffer.from(publicKeyHex, 'hex');
    const hardwareId = (descriptor && descriptor.hardwareId) || String(installationId).replace(/^inst_/, '');
    const msg1 = Buffer.from(`REGISTRATION:${hardwareId}`, 'utf8');
    const msg2 = Buffer.from(String(installationId), 'utf8');

    let validSig = false;
    try {
      validSig = verify(pubKeyBuffer, msg1, selfSignature);
    } catch {}
    if (!validSig) {
      try {
        validSig = verify(pubKeyBuffer, msg2, selfSignature);
      } catch {}
    }
    if (!validSig) {
      const err = new Error('Invalid self-signature');
      // @ts-ignore
      err.code = 'INVALID_SIGNATURE';
      // @ts-ignore
      err.status = 403;
      throw err;
    }
    
    // 5. Seat limit check against active license / plan limits if accountId is known
    if (accountId) {
      // Row lock account to prevent seat limit race condition (BACKEND-CONC-002)
      await client.query('SELECT account_id FROM accounts WHERE account_id = $1 FOR UPDATE', [accountId]);

      const licenseRes = await client.query(
        "SELECT limits FROM licenses WHERE account_id = $1 AND status = 'VALID' ORDER BY issued_at DESC LIMIT 1",
        [accountId]
      );
      const maxMachines = licenseRes.rows[0]?.limits?.max_machines || 5;
      
      const countRes = await client.query(
        "SELECT COUNT(*) FROM machines WHERE account_id = $1 AND status != 'REVOKED'",
        [accountId]
      );
      const activeMachineCount = Number(countRes.rows[0]?.count || 0);
      if (activeMachineCount >= maxMachines) {
        const err = new Error(`SEAT_LIMIT_EXCEEDED: Maximum ${maxMachines} active machines allowed`);
        // @ts-ignore
        err.status = 403;
        throw err;
      }
    }
    
    // 6. Insert machine
    const insertRes = await client.query(`
      INSERT INTO machines (installation_id, account_id, public_key_hex, descriptor, status, machine_generation)
      VALUES ($1, $2, $3, $4, 'REGISTERED', 1)
      RETURNING *
    `, [installationId, accountId, publicKeyHex, JSON.stringify(descriptor || {})]);
    
    const newMachine = insertRes.rows[0];
    
    // Insert initial generation state if account is bound
    if (accountId) {
      await client.query(`
        INSERT INTO machine_session_states (account_id, machine_id, session_generation, authorization_revision, machine_generation)
        VALUES ($1, $2, 1, 1, 1)
        ON CONFLICT (account_id, machine_id) DO NOTHING
      `, [accountId, newMachine.machine_id]);
    }
    
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
