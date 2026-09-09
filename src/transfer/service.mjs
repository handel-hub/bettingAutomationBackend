import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getPool } from '../persistence/connection.mjs';
import { withTransaction } from '../persistence/transaction.mjs';
import { createUpload, writeChunk, deleteUpload } from '../adapters/storage/adapter.mjs';

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
 * Initialize file transfer matching CP TransferWorker schema
 * @param {string} sessionId 
 * @param {Object} params 
 * @returns {Promise<{transferId: string, remoteSessionId: string, status: string}>}
 */
export async function initialize(sessionId, params) {
  return withTransaction('READ COMMITTED', async (client) => {
    // Check session validity
    const sessionRes = await client.query('SELECT status, account_id FROM sessions WHERE session_id = $1', [sessionId]);
    if (sessionRes.rows.length === 0 || sessionRes.rows[0].status !== 'AUTHENTICATED') {
      const err = new Error('UNAUTHORIZED');
      // @ts-ignore
      err.status = 401;
      throw err;
    }

    const {
      fileId,
      filename,
      totalSize,
      size,
      totalChunks,
      chunkSize,
      contentHash,
      hash,
      hashAlgorithm = 'sha256',
      metadata = {}
    } = params;

    const actualFileId = fileId || filename || 'unknown_file';
    const actualSize = BigInt(totalSize ?? size ?? 0);
    const actualHash = contentHash || hash || '';
    const actualChunkSize = Number(chunkSize || 65536);
    const actualTotalChunks = Number(totalChunks || Math.ceil(Number(actualSize) / actualChunkSize) || 1);

    const remoteSessionId = randomUUID();
    await createUpload(remoteSessionId);

    const res = await client.query(`
      INSERT INTO file_transfers (
        session_id, remote_session_id, file_id, total_size, total_chunks,
        chunk_size, content_hash, hash_algorithm, metadata, status, acked_chunks
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'INITIALIZING', '[]'::jsonb)
      RETURNING transfer_id, remote_session_id, status
    `, [
      sessionId,
      remoteSessionId,
      actualFileId,
      actualSize,
      actualTotalChunks,
      actualChunkSize,
      actualHash,
      hashAlgorithm,
      JSON.stringify(metadata)
    ]);

    const row = res.rows[0];
    return {
      transferId: row.transfer_id,
      remoteSessionId: row.remote_session_id,
      status: row.status
    };
  });
}

/**
 * Upload a chunk
 * @param {string} remoteSessionId 
 * @param {number} offset 
 * @param {Buffer} data 
 * @returns {Promise<{remoteSessionId: string, acked: boolean, offset: number, ackedRanges: Array<[number, number]>}>}
 */
export async function uploadChunk(remoteSessionId, offset, data) {
  return withTransaction('READ COMMITTED', async (client) => {
    const res = await client.query('SELECT * FROM file_transfers WHERE remote_session_id = $1 FOR UPDATE', [remoteSessionId]);
    if (res.rows.length === 0) {
      const err = new Error('Transfer not found');
      // @ts-ignore
      err.status = 404;
      throw err;
    }
    const transfer = res.rows[0];
    
    if (transfer.status !== 'INITIALIZING' && transfer.status !== 'UPLOADING') {
      const err = new Error(`Transfer is in status ${transfer.status}`);
      // @ts-ignore
      err.status = 400;
      throw err;
    }

    await writeChunk(remoteSessionId, Number(offset), data);

    const chunkHash = crypto.createHash(transfer.hash_algorithm || 'sha256').update(data).digest('hex');
    const chunkSize = data.length;
    const chunkIndex = Math.floor(Number(offset) / Number(transfer.chunk_size || chunkSize));

    // Record chunk in file_transfer_chunks
    await client.query(`
      INSERT INTO file_transfer_chunks (transfer_id, chunk_index, chunk_offset, chunk_size, chunk_hash, acked, acked_at)
      VALUES ($1, $2, $3, $4, $5, true, now())
      ON CONFLICT (transfer_id, chunk_index) DO UPDATE 
      SET acked = true, acked_at = now(), chunk_hash = $5
    `, [transfer.transfer_id, chunkIndex, offset, chunkSize, chunkHash]);

    const chunkEnd = Number(offset) + chunkSize - 1;
    const currentRanges = transfer.acked_chunks || [];
    const newRanges = mergeRanges(currentRanges, [Number(offset), chunkEnd]);

    await client.query(`
      UPDATE file_transfers 
      SET status = 'UPLOADING', 
          acked_chunks = $1,
          updated_at = now()
      WHERE transfer_id = $2
    `, [JSON.stringify(newRanges), transfer.transfer_id]);
    
    return {
      remoteSessionId,
      acked: true,
      offset: Number(offset),
      ackedRanges: newRanges
    };
  });
}

/**
 * Complete a transfer
 * @param {string} remoteSessionId 
 * @returns {Promise<{success: boolean, status: string}>}
 */
export async function complete(remoteSessionId) {
  return withTransaction('READ COMMITTED', async (client) => {
    const res = await client.query('SELECT * FROM file_transfers WHERE remote_session_id = $1 FOR UPDATE', [remoteSessionId]);
    if (res.rows.length === 0) {
      const err = new Error('Transfer not found');
      // @ts-ignore
      err.status = 404;
      throw err;
    }
    const transfer = res.rows[0];

    // Verify hash if provided
    if (transfer.content_hash) {
      const filePath = path.join(process.env.UPLOAD_DIR || '/tmp/uploads', remoteSessionId);
      try {
        const fileBytes = await fs.readFile(filePath);
        const actualHash = crypto.createHash(transfer.hash_algorithm || 'sha256').update(fileBytes).digest('hex');
        if (actualHash.toLowerCase() !== transfer.content_hash.toLowerCase()) {
          await client.query("UPDATE file_transfers SET status = 'FAILED', updated_at = now() WHERE transfer_id = $1", [transfer.transfer_id]);
          const err = new Error('Content hash verification failed');
          // @ts-ignore
          err.status = 400;
          throw err;
        }
      } catch (readErr) {
        // @ts-ignore
        if (readErr.status) throw readErr;
      }
    }

    await client.query(`
      UPDATE file_transfers 
      SET status = 'COMPLETED', completed_at = now(), updated_at = now()
      WHERE transfer_id = $1
    `, [transfer.transfer_id]);

    return { success: true, status: 'COMPLETED' };
  });
}

/**
 * Query transfer status
 * @param {string} remoteSessionId 
 * @returns {Promise<Object>}
 */
export async function getStatus(remoteSessionId) {
  const pool = getPool();
  const res = await pool.query('SELECT * FROM file_transfers WHERE remote_session_id = $1', [remoteSessionId]);
  if (res.rows.length === 0) {
    const err = new Error('Transfer not found');
    // @ts-ignore
    err.status = 404;
    throw err;
  }
  const t = res.rows[0];
  return {
    remoteSessionId: t.remote_session_id,
    transferId: t.transfer_id,
    fileId: t.file_id,
    status: t.status,
    totalSize: Number(t.total_size),
    ackedChunks: t.acked_chunks,
    contentHash: t.content_hash
  };
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
      SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
      WHERE remote_session_id = $1
      RETURNING remote_session_id
    `, [remoteSessionId]);
    
    if (res.rows.length > 0) {
      await deleteUpload(res.rows[0].remote_session_id);
    }
  });
}
