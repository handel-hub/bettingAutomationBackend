// @ts-check
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/uploads';

export async function initializeStorage() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

function sanitizeUploadId(rawId) {
  const base = path.basename(String(rawId || '')).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!base || base === '.' || base === '..') {
    throw new Error('Invalid uploadId');
  }
  return base;
}

/**
 * Initialize a new upload.
 * @param {string} [customUploadId]
 * @returns {Promise<string>}
 */
export async function createUpload(customUploadId) {
  await initializeStorage();
  const uploadId = sanitizeUploadId(customUploadId || randomUUID());
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
  const safeId = sanitizeUploadId(uploadId);
  const filePath = path.join(UPLOAD_DIR, safeId);
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
  const safeId = sanitizeUploadId(uploadId);
  const filePath = path.join(UPLOAD_DIR, safeId);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
