// @ts-check
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/uploads';

export async function initializeStorage() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

/**
 * Initialize a new upload.
 * @returns {Promise<string>}
 */
export async function createUpload() {
  const uploadId = randomUUID();
  const filePath = path.join(UPLOAD_DIR, uploadId);
  // Create empty file
  const fh = await fs.open(filePath, 'w');
  await fh.close();
  return uploadId;
}

/**
 * Write chunk
 * @param {string} uploadId 
 * @param {number} offset 
 * @param {Buffer} data 
 * @returns {Promise<void>}
 */
export async function writeChunk(uploadId, offset, data) {
  const filePath = path.join(UPLOAD_DIR, uploadId);
  const fh = await fs.open(filePath, 'r+');
  await fh.write(data, 0, data.length, offset);
  await fh.close();
}

/**
 * Cleanup an upload (on cancel)
 * @param {string} uploadId 
 * @returns {Promise<void>}
 */
export async function deleteUpload(uploadId) {
  const filePath = path.join(UPLOAD_DIR, uploadId);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
