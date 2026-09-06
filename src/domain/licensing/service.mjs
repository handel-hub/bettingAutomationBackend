// @ts-check

/**
 * Get active license capabilities for an account
 * @param {import('pg').PoolClient} client
 * @param {string} accountId 
 * @param {string} machineId 
 * @returns {Promise<any>}
 */
export async function getActiveLicenseForAuth(client, accountId, machineId) {
  // Finds the active license, or returns null
  // This is a read operation
  const res = await client.query(`
    SELECT * FROM licenses 
    WHERE account_id = $1 
    AND status = 'VALID' 
    -- EV-13: machine_binding logic could go here
    LIMIT 1
  `, [accountId]);
  
  return res.rows[0] || null;
}
