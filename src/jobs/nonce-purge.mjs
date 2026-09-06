// @ts-check

/**
 * Purges expired nonces
 * @param {import('pg').PoolClient} client 
 */
export async function purgeNonces(client) {
  // CRIT-06 fix: nonces are safe to delete after the 30-second window
  // We'll give it a generous 2 minute window before deleting.
  const res = await client.query(`
    DELETE FROM server_nonces 
    WHERE created_at < now() - interval '2 minutes'
  `);
  console.log(`Purged ${res.rowCount} nonces`);
}
