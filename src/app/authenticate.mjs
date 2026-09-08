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
    
    // 2. Lock machine if provided
    if (machineId) {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(machineId);
      let machine = null;
      if (isUUID) {
        const machineRes = await client.query('SELECT * FROM machines WHERE machine_id = $1 AND account_id = $2 FOR UPDATE', [machineId, account.account_id]);
        machine = machineRes.rows[0];
      }
      
      if (!machine || machine.status === 'REVOKED') {
        // Unregistered machine -> PARTIAL auth (stateless token to prevent FK violation on sessions table)
        isPartial = true;
        const { randomUUID } = await import('crypto');
        sessionId = randomUUID();
      } else {
        // 3. Retire existing session
        const updateOldSessRes = await client.query(`
          UPDATE sessions SET status = 'REVOKED'
          WHERE machine_id = $1 AND status = 'AUTHENTICATED'
          RETURNING session_id
        `, [machineId]);
        
        // 4. Advance generation exactly once
        const genRes = await client.query(`
          UPDATE machine_session_states SET session_generation = session_generation + 1
          WHERE machine_id = $1
          RETURNING session_generation
        `, [machineId]);
        sessionGeneration = genRes.rows[0] ? genRes.rows[0].session_generation : 1;
        
        // 5. Create new session
        const insertSessionRes = await client.query(`
          INSERT INTO sessions (account_id, machine_id, status, session_generation, renew_after, expires_at, session_protocol_version)
          VALUES ($1, $2, 'AUTHENTICATED', $3, now() + interval '1 hour', now() + interval '2 hours', $4)
          RETURNING session_id
        `, [account.account_id, machineId, sessionGeneration, protocolVersion]);
        sessionId = insertSessionRes.rows[0].session_id;
        
        // 6. Compute capabilities and create authorization record
        const license = await getActiveLicenseForAuth(client, account.account_id, machineId);
        const capabilities = computeCapabilities(license);
        
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
            machineId,
            sessionId: updateOldSessRes.rows[0].session_id,
            eventType: 'SESSION_REVOKED',
            severity: 'LOW',
            actorType: 'SYSTEM',
            result: 'SUCCESS',
            reason: 'superseded_by_new_authentication'
          });
        }
      }
    } else {
      isPartial = true; 
      // No machine ID -> PARTIAL session (stateless, no DB row because sessions.machine_id is NOT NULL)
      // The client will use this PARTIAL token to call /machines/register
      const { randomUUID } = await import('crypto');
      sessionId = randomUUID(); // Stateless session ID
    }
    
    // 7. Audit log for login success
    await logEvent(client, {
      accountId: account.account_id,
      machineId: isPartial ? undefined : (machineId || undefined),
      sessionId: isPartial ? undefined : sessionId,
      eventType: 'LOGIN_SUCCESS',
      severity: 'LOW',
      actorType: 'USER',
      result: 'SUCCESS',
      metadata: isPartial ? { partial_token: sessionId, presented_machine_id: machineId } : {}
    });
    
    // Issue signed GraceToken if authenticated (Phase 9 / CRIT-04)
    let graceToken = null;
    if (!isPartial && machineId) {
      const { issueGraceToken } = await import('../domain/licensing/grace-token.mjs');
      const license = await getActiveLicenseForAuth(client, account.account_id, machineId);
      const capabilities = computeCapabilities(license);
      const riskTier = license?.limits?.risk_tier || 'LOW_RISK';
      graceToken = await issueGraceToken(account.account_id, machineId, capabilities, riskTier);
    }
    
    return {
      sessionId,
      status: isPartial ? 'PARTIAL' : 'AUTHENTICATED',
      sessionGeneration,
      graceToken
    };
  });
}
