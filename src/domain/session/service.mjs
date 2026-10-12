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
      const err = new Error('Session state not found');
      // @ts-ignore
      err.status = 401;
      // @ts-ignore
      err.code = 'SESSION_REVOKED';
      throw err;
    }
    const state = stateRes.rows[0];
    
    // 2. Lock session
    const session = await getSessionForUpdate(client, sessionId);
    if (!session || session.machine_id !== machineId) {
      const err = new Error('AUTH_FAILED');
      // @ts-ignore
      err.status = 401;
      // @ts-ignore
      err.code = 'SESSION_REVOKED';
      throw err;
    }
    
    if (session.status !== 'AUTHENTICATED' || (session.expires_at && new Date(session.expires_at) <= new Date())) {
      const err = new Error('Session is inactive or expired');
      // @ts-ignore
      err.status = 401;
      throw err;
    }

    const acctRes = await client.query('SELECT status FROM accounts WHERE account_id = $1', [session.account_id]);
    if (acctRes.rows.length === 0 || acctRes.rows[0].status !== 'ACTIVE') {
      const err = new Error('Account is inactive or locked');
      // @ts-ignore
      err.status = 403;
      throw err;
    }
    
    // 3. Generation check - require explicit numeric session and/or machine generation
    let clientSessionGen;
    let clientMachineGen = state.machine_generation;
    
    if (typeof presentedGenerationState === 'number') {
      clientSessionGen = presentedGenerationState;
    } else if (presentedGenerationState && typeof presentedGenerationState === 'object') {
      if (presentedGenerationState.session === undefined && presentedGenerationState.generation === undefined) {
        const err = new Error('GENERATION_MISMATCH');
        // @ts-ignore
        err.status = 403;
        // @ts-ignore
        err.code = 'GENERATION_MISMATCH';
        throw err;
      }
      clientSessionGen = presentedGenerationState.session ?? presentedGenerationState.generation;
      if (presentedGenerationState.machine !== undefined) {
        clientMachineGen = presentedGenerationState.machine;
      }
    } else {
      const err = new Error('GENERATION_MISMATCH');
      // @ts-ignore
      err.status = 403;
      // @ts-ignore
      err.code = 'GENERATION_MISMATCH';
      throw err;
    }
    
    if (Number(clientSessionGen) !== Number(state.session_generation) || 
        Number(clientMachineGen) !== Number(state.machine_generation)) {
      const err = new Error('GENERATION_MISMATCH');
      // @ts-ignore
      err.status = 403;
      // @ts-ignore
      err.code = 'GENERATION_MISMATCH';
      throw err;
    }
    
    // 4. Advance session generation in both machine_session_states and sessions table
    const genRes = await client.query(`
      UPDATE machine_session_states 
      SET session_generation = session_generation + 1
      WHERE machine_id = $1 AND account_id = $2
      RETURNING session_generation
    `, [machineId, session.account_id]);
    const nextGeneration = genRes.rows[0] ? Number(genRes.rows[0].session_generation) : (Number(state.session_generation) + 1);

    await client.query(`
      UPDATE sessions 
      SET session_generation = $1, renew_after = now() + interval '1 hour', expires_at = now() + interval '2 hours'
      WHERE session_id = $2
    `, [nextGeneration, sessionId]);
    
    // 5. Log
    await logEvent(client, {
      accountId: session.account_id,
      machineId,
      sessionId,
      eventType: 'SESSION_RENEWED',
      severity: 'LOW',
      actorType: 'SYSTEM',
      result: 'SUCCESS',
      metadata: { previousGeneration: state.session_generation, newGeneration: nextGeneration }
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
      sessionGeneration: nextGeneration,
      generation: nextGeneration,
      capabilities,
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
export async function logout(sessionId, machineId = null) {
  const res = await withTransaction('READ COMMITTED', async (client) => {
    const sessRes = await client.query(`
      UPDATE sessions 
      SET status = 'LOGGED_OUT'
      WHERE session_id = $1 AND ($2::uuid IS NULL OR machine_id = $2)
      RETURNING account_id, machine_id
    `, [sessionId, machineId || null]);

    await client.query(`
      UPDATE authorizations
      SET status = 'REVOKED', updated_at = now()
      WHERE session_id = $1 AND status = 'VALID'
    `, [sessionId]);

    if (sessRes.rows.length > 0) {
      const targetMachineId = machineId || sessRes.rows[0].machine_id;
      if (targetMachineId) {
        await client.query(`
          UPDATE machine_session_states
          SET session_generation = session_generation + 1, updated_at = now()
          WHERE account_id = $1 AND machine_id = $2
        `, [sessRes.rows[0].account_id, targetMachineId]);
      }
    }
    return sessRes.rows[0];
  });

  try {
    const { closeWebSocketsForTarget } = await import('../../websocket/server.mjs');
    closeWebSocketsForTarget({ sessionId });
  } catch {
    // ignore if ws server not initialized
  }
  return res;
}
