// @ts-check

/**
 * Sweeps expired sessions and changes status to EXPIRED
 * @param {import('pg').PoolClient} client 
 */
export async function cleanupSessions(client) {
  const res = await client.query(`
    UPDATE sessions 
    SET status = 'EXPIRED' 
    WHERE status = 'AUTHENTICATED' AND expires_at < now()
  `);
  if (res.rowCount > 0) {
    console.log(`Expired ${res.rowCount} sessions`);
  }
}
