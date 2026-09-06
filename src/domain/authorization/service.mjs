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
  return withTransaction('READ COMMITTED', async (client) => {
    // 1. Get session
    const sessionRes = await client.query('SELECT account_id, status FROM sessions WHERE session_id = $1 AND machine_id = $2', [sessionId, machineId]);
    if (sessionRes.rows.length === 0) {
      throw new Error('Session not found');
    }
    const session = sessionRes.rows[0];
    if (session.status !== 'AUTHENTICATED') {
      const err = new Error('Session not authenticated');
      err.status = 403;
      throw err;
    }
    
    // 2. Lock license to avoid stale read (Freeze Audit P0-6)
    const licenseRes = await client.query(`
      SELECT * FROM licenses 
      WHERE account_id = $1 AND status = 'VALID' 
      ORDER BY issued_at DESC LIMIT 1
      FOR UPDATE
    `, [session.account_id]);
    
    const license = licenseRes.rows[0];
    if (!license) {
      throw new Error('No valid license found');
    }
    
    // 3. Update machine_session_states authorization_revision
    const stateRes = await client.query(`
      UPDATE machine_session_states 
      SET authorization_revision = authorization_revision + 1 
      WHERE machine_id = $1 
      RETURNING authorization_revision
    `, [machineId]);
    
    const newRevision = stateRes.rows[0].authorization_revision;
    
    // 4. Compute capabilities
    const capabilities = computeCapabilities(license);
    
    // 5. Insert authorization record, stamping observed_license_revision
    const authRes = await client.query(`
      INSERT INTO authorizations (session_id, account_id, license_id, status, capability_set, observed_license_revision, expires_at)
      VALUES ($1, $2, $3, 'VALID', $4, $5, now() + interval '2 hours')
      RETURNING *
    `, [sessionId, session.account_id, license.license_id, JSON.stringify(capabilities), license.license_revision]);
    
    return {
      authorization: authRes.rows[0],
      revision: newRevision
    };
  });
}
