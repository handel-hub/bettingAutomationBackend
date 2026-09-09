// @ts-check
import { deleteUpload } from '../adapters/storage/adapter.mjs';

/**
 * Clean up incomplete file transfers older than 24 hours.
 * Marks transfers as FAILED and purges local chunk/file storage.
 * @param {import('pg').PoolClient} client 
 */
export async function cleanupStaleTransfers(client) {
  const res = await client.query(`
    SELECT transfer_id, file_id 
    FROM file_transfers 
    WHERE status IN ('INITIALIZING', 'UPLOADING')
      AND created_at < now() - interval '24 hours'
  `);

  for (const row of res.rows) {
    await client.query(`
      UPDATE file_transfers 
      SET status = 'FAILED', updated_at = now() 
      WHERE transfer_id = $1
    `, [row.transfer_id]);

    try {
      await deleteUpload(row.file_id);
    } catch (err) {
      console.warn(`[transfer-cleanup] Failed to delete file ${row.file_id}:`, err.message);
    }
  }

  if (res.rowCount > 0) {
    console.log(`[transfer-cleanup] Cleaned up ${res.rowCount} stale file transfers`);
  }
}
