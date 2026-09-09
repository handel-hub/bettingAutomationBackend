// @ts-check
import fs from 'fs';
import path from 'path';

const EPOCH_FILE_PATH = process.env.SERVER_EPOCH_FILE || path.resolve(process.cwd(), 'data', 'server_epoch.json');

/**
 * Ensures directory and epoch file exist.
 * @param {number} [initialEpoch=1] 
 */
export function initializeEpochStore(initialEpoch = 1) {
  try {
    const dir = path.dirname(EPOCH_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(EPOCH_FILE_PATH)) {
      fs.writeFileSync(EPOCH_FILE_PATH, JSON.stringify({ epoch: initialEpoch, updatedAt: new Date().toISOString() }), 'utf8');
    }
  } catch (err) {
    console.error('[EpochStore] Failed to initialize epoch store:', err);
    throw err;
  }
}

/**
 * Retrieve the monotonic server epoch from persistent storage outside PostgreSQL.
 * @returns {number}
 */
export function getSystemEpoch() {
  try {
    if (!fs.existsSync(EPOCH_FILE_PATH)) {
      initializeEpochStore(1);
    }
    const raw = fs.readFileSync(EPOCH_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Number(parsed.epoch || 1);
  } catch (err) {
    console.error('[EpochStore] Failed to read system epoch; failing closed:', err);
    throw new Error('SYSTEM_EPOCH_UNAVAILABLE');
  }
}

/**
 * Monotonically advance the server epoch.
 * @returns {number} The new epoch
 */
export function advanceSystemEpoch() {
  try {
    const current = getSystemEpoch();
    const next = current + 1;
    const tempFile = `${EPOCH_FILE_PATH}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify({ epoch: next, updatedAt: new Date().toISOString() }), 'utf8');
    fs.renameSync(tempFile, EPOCH_FILE_PATH);
    return next;
  } catch (err) {
    console.error('[EpochStore] Failed to advance system epoch:', err);
    throw new Error('SYSTEM_EPOCH_ADVANCE_FAILED');
  }
}

/**
 * Set an explicit system epoch (useful for testing or manual operator recovery)
 * @param {number} epoch 
 */
export function setSystemEpoch(epoch) {
  const dir = path.dirname(EPOCH_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(EPOCH_FILE_PATH, JSON.stringify({ epoch: Number(epoch), updatedAt: new Date().toISOString() }), 'utf8');
}
