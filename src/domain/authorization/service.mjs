// @ts-check
import { withTransaction } from '../../persistence/transaction.mjs';

/**
 * Compute the authorization capability set based on the active license.
 * @param {any} license 
 * @returns {any} capabilities JSON
 */
export function computeCapabilities(license) {
  if (!license) return {};
  return license.capabilities || {};
}

/**
 * Resolve authorization for a session
 * @param {string} sessionId 
 * @param {string} machineId 
 * @param {any} presentedGenerationState 
 * @returns {Promise<any>}
 */
export async function resolve(sessionId, machineId, presentedGenerationState) {
  return withTransaction('SERIALIZABLE', async (client) => {
    // 1. Lock session with FOR UPDATE to prevent concurrent revocation race (BACKEND-CONC-001)
    const sessionRes = await client.query(
      'SELECT account_id, status FROM sessions WHERE session_id = $1 AND machine_id = $2 FOR UPDATE',
      [sessionId, machineId]
    );
    if (sessionRes.rows.length === 0) {
      const err = new Error('Session not found');
      // @ts-ignore
      err.status = 404;
      throw err;
    }
    const session = sessionRes.rows[0];
    if (session.status !== 'AUTHENTICATED') {
      const err = new Error('Session not authenticated or revoked');
      // @ts-ignore
      err.status = 403;
      // @ts-ignore
      err.code = 'SESSION_REVOKED';
      throw err;
    }

    // 2. Lock machine and verify not revoked
    const machineRes = await client.query(
      'SELECT status FROM machines WHERE machine_id = $1 FOR UPDATE',
      [machineId]
    );
    if (machineRes.rows.length === 0 || machineRes.rows[0].status === 'REVOKED') {
      const err = new Error('Machine not found or revoked');
      // @ts-ignore
      err.status = 403;
      // @ts-ignore
      err.code = 'MACHINE_REVOKED';
      throw err;
    }
    
    // 3. Lock license to avoid stale read
    const licenseRes = await client.query(`
      SELECT * FROM licenses 
      WHERE account_id = $1 AND status = 'VALID' 
      ORDER BY issued_at DESC LIMIT 1
      FOR UPDATE
    `, [session.account_id]);
    
    const license = licenseRes.rows[0];
    if (!license) {
      const err = new Error('No valid license found');
      // @ts-ignore
      err.status = 403;
      throw err;
    }

    // 4. Lock machine_session_states and validate generation state
    const stateRes = await client.query(`
      SELECT session_generation, machine_generation, authorization_revision
      FROM machine_session_states
      WHERE machine_id = $1 AND account_id = $2
      FOR UPDATE
    `, [machineId, session.account_id]);

    if (stateRes.rows.length > 0 && presentedGenerationState) {
      const current = stateRes.rows[0];
      let clientGen = typeof presentedGenerationState === 'number' ? presentedGenerationState : presentedGenerationState.session;
      if (clientGen !== undefined && Number(clientGen) !== Number(current.session_generation)) {
        const err = new Error('GENERATION_MISMATCH');
        // @ts-ignore
        err.status = 403;
        // @ts-ignore
        err.code = 'GENERATION_MISMATCH';
        throw err;
      }
    }
    
    // 5. Update machine_session_states authorization_revision
    const updateStateRes = await client.query(`
      UPDATE machine_session_states 
      SET authorization_revision = authorization_revision + 1 
      WHERE machine_id = $1 AND account_id = $2
      RETURNING authorization_revision
    `, [machineId, session.account_id]);
    
    const newRevision = updateStateRes.rows[0]?.authorization_revision || 1;
    
    // 6. Compute capabilities
    const capabilities = computeCapabilities(license);

    // 7. Supersede any previous active authorizations for this session
    await client.query(`
      UPDATE authorizations
      SET status = 'SUPERSEDED', updated_at = now()
      WHERE session_id = $1 AND status = 'VALID'
    `, [sessionId]);
    
    // 8. Insert new authorization record
    const authRes = await client.query(`
      INSERT INTO authorizations (session_id, account_id, license_id, status, capability_set, observed_license_revision, expires_at)
      VALUES ($1, $2, $3, 'VALID', $4, $5, now() + interval '2 hours')
      RETURNING *
    `, [sessionId, session.account_id, license.license_id, JSON.stringify(capabilities), license.license_revision]);

    const authRow = authRes.rows[0];
    
    return {
      authorization: authRow,
      revision: newRevision,
      authzData: {
        authorizationId: authRow.authorization_id,
        status: 'VALID',
        capabilities,
        revision: newRevision,
        expiresAt: authRow.expires_at
      }
    };
  });
}
