// @ts-check
import { withTransaction } from '../../persistence/transaction.mjs';
import { createUpload, writeChunk, deleteUpload } from '../../adapters/storage/adapter.mjs';

/**
 * Merge a range [start, end] into a sorted array of disjoint ranges.
 * @param {Array<[number, number]>} ranges 
 * @param {[number, number]} newRange 
 * @returns {Array<[number, number]>}
 */
function mergeRanges(ranges, newRange) {
  const result = [];
  let [start, end] = newRange;
  
  for (const range of ranges) {
    if (range[1] < start - 1) {
      result.push(range);
    } else if (range[0] > end + 1) {
      result.push([start, end]);
      start = range[0];
      end = range[1];
    } else {
      start = Math.min(start, range[0]);
      end = Math.max(end, range[1]);
    }
  }
  result.push([start, end]);
  return result;
}

/**
 * Initialize file transfer
 * @param {string} sessionId 
 * @param {string} filename 
 * @param {number} size 
 * @param {string} hash 
 * @returns {Promise<{transfer_id: string, remote_session_id: string}>}
 */
export async function initialize(sessionId, filename, size, hash) {
  return withTransaction('READ COMMITTED', async (client) => {
    // Check authorization (e.g., does session have CAP_FILE_UPLOAD?)
    // Here we'll just verify the session exists for simplicity
    const sessionRes = await client.query('SELECT status FROM sessions WHERE session_id = $1', [sessionId]);
    if (sessionRes.rows.length === 0 || sessionRes.rows[0].status !== 'AUTHENTICATED') {
      throw new Error('UNAUTHORIZED');
    }

    const uploadId = await createUpload();

    const res = await client.query(`
      INSERT INTO file_transfers (session_id, remote_path, total_size, expected_hash, storage_path, status, acked_chunks)
      VALUES ($1, $2, $3, $4, $5, 'PENDING', '[]'::jsonb)
      RETURNING transfer_id, remote_session_id
    `, [sessionId, filename, size, hash, uploadId]);

    return res.rows[0];
  });
}

/**
 * Upload a chunk
 * @param {string} remoteSessionId 
 * @param {number} offset 
 * @param {Buffer} data 
 * @returns {Promise<{acked_chunks: Array<[number, number]>}>}
 */
export async function uploadChunk(remoteSessionId, offset, data) {
  return withTransaction('READ COMMITTED', async (client) => {
    const res = await client.query('SELECT * FROM file_transfers WHERE remote_session_id = $1 FOR UPDATE', [remoteSessionId]);
    if (res.rows.length === 0) throw new Error('Transfer not found');
    const transfer = res.rows[0];
    
    if (transfer.status !== 'PENDING' && transfer.status !== 'IN_PROGRESS') {
      throw new Error(`Transfer is ${transfer.status}`);
    }

    await writeChunk(transfer.storage_path, offset, data);

    const chunkEnd = offset + data.length - 1;
    const currentRanges = transfer.acked_chunks || [];
    const newRanges = mergeRanges(currentRanges, [offset, chunkEnd]);

    await client.query(`
      UPDATE file_transfers 
      SET status = 'IN_PROGRESS', 
          acked_chunks = $1,
          transferred_size = (
            SELECT COALESCE(SUM(range_end - range_start + 1), 0)
            FROM jsonb_array_elements($1) as arr(val),
                 LATERAL (SELECT (val->>0)::bigint as range_start, (val->>1)::bigint as range_end) as bounds
          )
      WHERE transfer_id = $2
    `, [JSON.stringify(newRanges), transfer.transfer_id]);
    
    return { acked_chunks: newRanges };
  });
}

/**
 * Complete a transfer
 * @param {string} remoteSessionId 
 * @returns {Promise<void>}
 */
export async function complete(remoteSessionId) {
  return withTransaction('READ COMMITTED', async (client) => {
    // In reality: verify total size matches and compute hash
    await client.query(`
      UPDATE file_transfers 
      SET status = 'COMPLETED', completed_at = now() 
      WHERE remote_session_id = $1
    `, [remoteSessionId]);
  });
}

/**
 * Cancel a transfer
 * @param {string} remoteSessionId 
 * @returns {Promise<void>}
 */
export async function cancel(remoteSessionId) {
  return withTransaction('READ COMMITTED', async (client) => {
    const res = await client.query(`
      UPDATE file_transfers 
      SET status = 'CANCELLED', cancelled_at = now() 
      WHERE remote_session_id = $1
      RETURNING storage_path
    `, [remoteSessionId]);
    
    if (res.rows.length > 0) {
      await deleteUpload(res.rows[0].storage_path);
    }
  });
}
