// @ts-check
import { withTransaction } from '../../persistence/transaction.mjs';
import { getSessionForUpdate, renewSessionInDb, revokeSessionInDb } from './repository.mjs';
import { logEvent } from '../audit/service.mjs';

/**
 * Renew an existing active session
 * @param {string} sessionId 
 * @param {string} machineId 
 * @param {any} presentedGenerationState 
 * @param {string} clientNonce 
 * @returns {Promise<any>}
 */
export async function renew(sessionId, machineId, presentedGenerationState, clientNonce) {
  return withTransaction('SERIALIZABLE', async (client) => {
    // 1. Lock machine_session_states
    const stateRes = await client.query('SELECT * FROM machine_session_states WHERE account_id = (SELECT account_id FROM sessions WHERE session_id = $1) AND machine_id = $2 FOR UPDATE', [sessionId, machineId]);
    if (stateRes.rows.length === 0) {
      throw new Error('Session state not found');
    }
    const state = stateRes.rows[0];
    
    // 2. Lock session
    const session = await getSessionForUpdate(client, sessionId);
    if (!session || session.machine_id !== machineId) {
      throw new Error('AUTH_FAILED');
    }
    
    if (session.status === 'EXPIRED' || session.status === 'REVOKED' || session.status === 'LOGGED_OUT') {
      const err = new Error('Session is inactive');
      err.status = 401;
      throw err;
    }
    
    // 3. Generation check - support both numeric generation and object state
    let clientSessionGen = state.session_generation;
    let clientMachineGen = state.machine_generation;
    
    if (typeof presentedGenerationState === 'number') {
      clientSessionGen = presentedGenerationState;
    } else if (presentedGenerationState && typeof presentedGenerationState === 'object') {
      clientSessionGen = presentedGenerationState.session ?? state.session_generation;
      clientMachineGen = presentedGenerationState.machine ?? state.machine_generation;
    }
    
    if (Number(clientSessionGen) !== Number(state.session_generation) || 
        Number(clientMachineGen) !== Number(state.machine_generation)) {
      const err = new Error('GENERATION_MISMATCH');
      err.status = 403;
      throw err;
    }
    
    // 4. Update session
    await renewSessionInDb(client, sessionId);
    
    // 5. Log
    await logEvent(client, {
      accountId: session.account_id,
      machineId,
      sessionId,
      eventType: 'SESSION_RENEWED',
      severity: 'LOW',
      actorType: 'SYSTEM',
      result: 'SUCCESS'
    });
    
    // 6. Issue GraceToken on session renewal (CRIT-04)
    const { issueGraceToken } = await import('../licensing/grace-token.mjs');
    const { getActiveLicenseForAuth } = await import('../licensing/service.mjs');
    const { computeCapabilities } = await import('../authorization/service.mjs');
    const license = await getActiveLicenseForAuth(client, session.account_id, machineId);
    const capabilities = computeCapabilities(license);
    const riskTier = license?.limits?.risk_tier || 'LOW_RISK';
    const graceToken = await issueGraceToken(session.account_id, machineId, capabilities, riskTier);
    
    return {
      status: 'AUTHENTICATED',
      sessionGeneration: state.session_generation,
      graceToken
    };
  });
}

/**
 * @param {string} sessionId 
 * @param {string} reason 
 */
export async function revoke(sessionId, reason) {
  return withTransaction('READ COMMITTED', async (client) => {
    await revokeSessionInDb(client, sessionId);
  });
}

/**
 * @param {string} sessionId 
 * @param {string} machineId 
 */
export async function logout(sessionId, machineId) {
  return withTransaction('READ COMMITTED', async (client) => {
    await client.query(`
      UPDATE sessions 
      SET status = 'LOGGED_OUT'
      WHERE session_id = $1 AND machine_id = $2
    `, [sessionId, machineId]);
  });
}
