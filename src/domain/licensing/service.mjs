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
    AND (expires_at IS NULL OR expires_at > now())
    ORDER BY issued_at DESC
    LIMIT 1
  `, [accountId]);
  
  return res.rows[0] || null;
}
