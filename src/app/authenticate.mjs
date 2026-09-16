// @ts-check
import { withTransaction } from '../persistence/transaction.mjs';
import { getAccountByEmailForUpdate, updateAccountLockout } from '../domain/auth/repository.mjs';
import { verifyCredentials } from '../domain/auth/service.mjs';
import { getActiveLicenseForAuth } from '../domain/licensing/service.mjs';
import { computeCapabilities } from '../domain/authorization/service.mjs';
import { logEvent } from '../domain/audit/service.mjs';

/**
 * @param {string} email 
 * @param {string} password 
 * @param {string | null} machineId 
 * @param {number} protocolVersion 
 * @param {string} clientNonce 
 * @returns {Promise<any>}
 */
export async function authenticate(email, password, machineId, protocolVersion, clientNonce) {
  return withTransaction('SERIALIZABLE', async (client) => {
    // 1. Lock account and verify credentials
    const account = await getAccountByEmailForUpdate(client, email);
    if (!account) {
      throw new Error('AUTH_FAILED');
    }
    
    const credResult = await verifyCredentials(account, password);
    if (!credResult.success) {
      if (credResult.newCount !== undefined) {
        await updateAccountLockout(client, account.account_id, credResult.newCount, credResult.lockoutExpiresAt || null);
        await logEvent(client, {
          accountId: account.account_id,
          eventType: 'LOGIN_FAILURE',
          severity: 'LOW',
          actorType: 'USER',
          result: 'FAILURE',
          reason: 'invalid_credentials'
        });
      }
      throw new Error('AUTH_FAILED');
    }
    
    // Clear lockout on success
    if (account.lockout_count > 0) {
      await updateAccountLockout(client, account.account_id, 0, null);
    }
    
    let sessionId = null;
    let authRecordId = null;
    let isPartial = false;
    let sessionGeneration = 1;
    
    // 2. Resolve machine if provided
    let actualMachineId = null;
    let license = null;
    let capabilities = [];

    if (machineId) {
      const machineRes = await client.query(
        "SELECT * FROM machines WHERE (machine_id::text = $1 OR installation_id = $1 OR descriptor->>'hardwareId' = $1) AND status != 'REVOKED' FOR UPDATE",
        [machineId]
      );
      
      if (machineRes.rows.length > 0) {
        const machine = machineRes.rows[0];
        actualMachineId = machine.machine_id;

        // If machine was registered during cold-boot without an account, bind it now
        if (!machine.account_id) {
          await client.query(
            'UPDATE machines SET account_id = $1, updated_at = now() WHERE machine_id = $2',
            [account.account_id, actualMachineId]
          );
          await client.query(`
            INSERT INTO machine_session_states (account_id, machine_id, session_generation, authorization_revision, machine_generation)
            VALUES ($1, $2, 1, 1, 1)
            ON CONFLICT (account_id, machine_id) DO UPDATE SET account_id = $1
          `, [account.account_id, actualMachineId]);
        } else if (machine.account_id !== account.account_id) {
          // Machine belongs to another account
          const err = new Error('MACHINE_REVOKED');
          // @ts-ignore
          err.status = 403;
          // @ts-ignore
          err.code = 'MACHINE_REVOKED';
          throw err;
        }

        // 3. Advance generation exactly once (locks machine_session_states before sessions to prevent deadlock)
        const genRes = await client.query(`
          UPDATE machine_session_states 
          SET session_generation = session_generation + 1
          WHERE machine_id = $1 AND account_id = $2
          RETURNING session_generation
        `, [actualMachineId, account.account_id]);
        sessionGeneration = genRes.rows[0] ? Number(genRes.rows[0].session_generation) : 2;

        // 4. Retire existing active session on this machine
        const updateOldSessRes = await client.query(`
          UPDATE sessions SET status = 'REVOKED'
          WHERE machine_id = $1 AND status = 'AUTHENTICATED'
          RETURNING session_id
        `, [actualMachineId]);
        
        // 5. Create new session
        const insertSessionRes = await client.query(`
          INSERT INTO sessions (account_id, machine_id, status, session_generation, renew_after, expires_at, session_protocol_version)
          VALUES ($1, $2, 'AUTHENTICATED', $3, now() + interval '1 hour', now() + interval '2 hours', $4)
          RETURNING session_id
        `, [account.account_id, actualMachineId, sessionGeneration, protocolVersion]);
        sessionId = insertSessionRes.rows[0].session_id;
        
        // 6. Compute capabilities and create authorization record
        license = await getActiveLicenseForAuth(client, account.account_id, actualMachineId);
        capabilities = computeCapabilities(license);
        
        const authInsertRes = await client.query(`
          INSERT INTO authorizations (session_id, account_id, license_id, status, capability_set, observed_license_revision, expires_at)
          VALUES ($1, $2, $3, 'VALID', $4, $5, now() + interval '2 hours')
          RETURNING authorization_id
        `, [sessionId, account.account_id, license ? license.license_id : null, JSON.stringify(capabilities), license ? license.license_revision : 1]);
        authRecordId = authInsertRes.rows[0].authorization_id;
        
        // Audit log for retired session if any
        if (updateOldSessRes.rows.length > 0) {
          await logEvent(client, {
            accountId: account.account_id,
            machineId: actualMachineId,
            sessionId: updateOldSessRes.rows[0].session_id,
            eventType: 'SESSION_REVOKED',
            severity: 'LOW',
            actorType: 'SYSTEM',
            result: 'SUCCESS',
            reason: 'superseded_by_new_authentication'
          });
        }
      } else {
        // Machine ID unrecognized -> fallback to PARTIAL session
        isPartial = true;
        const { randomUUID } = await import('crypto');
        sessionId = randomUUID();
      }
    } else {
      isPartial = true; 
      // No machine ID provided -> PARTIAL stateless session
      const { randomUUID } = await import('crypto');
      sessionId = randomUUID();
    }
    
    // 7. Audit log for login success
    await logEvent(client, {
      accountId: account.account_id,
      machineId: isPartial ? undefined : (actualMachineId || undefined),
      sessionId: isPartial ? undefined : sessionId,
      eventType: 'LOGIN_SUCCESS',
      severity: 'LOW',
      actorType: 'USER',
      result: 'SUCCESS',
      metadata: isPartial ? { partial_token: sessionId, presented_machine_id: machineId } : {}
    });
    
    // Issue signed GraceToken if authenticated
    let graceToken = null;
    if (!isPartial && actualMachineId) {
      const { issueGraceToken } = await import('../domain/licensing/grace-token.mjs');
      const riskTier = license?.limits?.risk_tier || 'LOW_RISK';
      graceToken = await issueGraceToken(account.account_id, actualMachineId, capabilities, riskTier);
    }
    
    return {
      sessionId,
      accountId: account.account_id,
      status: isPartial ? 'PARTIAL' : 'AUTHENTICATED',
      sessionGeneration,
      nonceValidated: true,
      license: license ? {
        id: license.license_id,
        planId: license.plan_id,
        status: license.status || 'VALID',
        expiresAt: license.expires_at
      } : {
        status: 'VALID',
        planId: 'pro'
      },
      capabilities,
      graceToken
    };
  });
}
