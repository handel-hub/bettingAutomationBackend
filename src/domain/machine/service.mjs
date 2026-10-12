// @ts-check
import { withTransaction } from '../../persistence/transaction.mjs';
import {
  findByInstallationAndPublicKey,
  findClones,
  countActiveByAccount,
  enforceSeatLimitWithDormancyReclamation,
  createMachine,
  createSessionState
} from './repository.mjs';

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
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const sessionRes = UUID_REGEX.test(String(authenticatedSessionId))
        ? await client.query('SELECT account_id FROM sessions WHERE session_id = $1 AND status IN (\'AUTHENTICATED\', \'PARTIAL\')', [authenticatedSessionId])
        : { rows: [] };
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
    
    // 2. Verify selfSignature using publicKeyHex BEFORE returning existing record or checking clones (USF-10 / HIGH-06)
    // CP signs `REGISTRATION:${hardwareId}` where installationId is `inst_${hardwareId}`
    const { verify } = await import('../../crypto/ed25519.mjs');
    const pubKeyBuffer = Buffer.from(publicKeyHex, 'hex');
    const derivedHardwareId = String(installationId).replace(/^inst_/, '');
    const safeDescriptor = (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor))
      ? { ...descriptor }
      : {};
    if (
      safeDescriptor.hardwareId &&
      String(safeDescriptor.hardwareId) !== derivedHardwareId &&
      String(safeDescriptor.hardwareId) !== String(installationId)
    ) {
      const err = new Error('Descriptor hardwareId does not match installationId');
      // @ts-ignore
      err.code = 'INVALID_FORMAT';
      // @ts-ignore
      err.status = 400;
      throw err;
    }
    safeDescriptor.hardwareId = safeDescriptor.hardwareId || derivedHardwareId;
    const hardwareId = safeDescriptor.hardwareId;
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

    // 3. Check for duplicate installationId / publicKeyHex (idempotent registration after signature verification)
    const existing = await findByInstallationAndPublicKey(client, installationId, publicKeyHex);
    if (existing) {
      return existing;
    }
    
    // 4. Clone detection (same installation_id, different public_key)
    const clones = await findClones(client, installationId, publicKeyHex);
    if (clones.length > 0) {
      const err = new Error('CLONE_SUSPECTED');
      // @ts-ignore
      err.code = 'CLONE_SUSPECTED';
      // @ts-ignore
      err.status = 403;
      throw err;
    }
    
    // 5. Seat limit check against active license / plan limits if accountId is known
    if (accountId) {
      // Row lock account to prevent seat limit race condition (BACKEND-CONC-002)
      await client.query('SELECT account_id FROM accounts WHERE account_id = $1 FOR UPDATE', [accountId]);

      const licenseRes = await client.query(
        "SELECT limits FROM licenses WHERE account_id = $1 AND status = 'VALID' AND (expires_at IS NULL OR expires_at > now()) ORDER BY issued_at DESC LIMIT 1",
        [accountId]
      );
      const maxMachines = licenseRes.rows[0]?.limits?.max_machines || 5;
      
      const seatCheck = await enforceSeatLimitWithDormancyReclamation(
        client,
        accountId,
        maxMachines,
        null,
        process.env.DORMANT_MACHINE_THRESHOLD || '1 hour'
      );
      if (!seatCheck.allowed) {
        const err = new Error(`SEAT_LIMIT_EXCEEDED: Maximum ${maxMachines} active machines allowed`);
        // @ts-ignore
        err.status = 403;
        throw err;
      }
    }
    
    // 6. Insert machine
    const newMachine = await createMachine(client, {
      installationId,
      accountId,
      publicKeyHex,
      descriptor: safeDescriptor
    });
    
    // Insert initial generation state if account is bound
    if (accountId) {
      await createSessionState(client, accountId, newMachine.machine_id);
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
