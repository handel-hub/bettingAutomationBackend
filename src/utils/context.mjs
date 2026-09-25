// @ts-check
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * @typedef {Object} RequestContext
 * @property {string} traceId
 * @property {string} [accountId]
 * @property {string} [machineId]
 * @property {string} [sessionId]
 * @property {string} [route]
 * @property {number} startTime
 * @property {number} queryCount
 * @property {number} queryDurationMs
 */

/** @type {AsyncLocalStorage<RequestContext>} */
const asyncLocalStorage = new AsyncLocalStorage();

/**
 * Run callback within the given asynchronous context store
 * @template T
 * @param {RequestContext} context 
 * @param {() => T} callback 
 * @returns {T}
 */
export function runWithContext(context, callback) {
  return asyncLocalStorage.run(context, callback);
}

/**
 * Retrieve the current active asynchronous context store
 * @returns {RequestContext | undefined}
 */
export function getContext() {
  return asyncLocalStorage.getStore();
}

/**
 * Update the current context store in-place
 * @param {Partial<RequestContext>} updates 
 */
export function updateContext(updates) {
  const store = asyncLocalStorage.getStore();
  if (store) {
    Object.assign(store, updates);
  }
}

/**
 * Increment SQL query count and duration in active context
 * @param {number} durationMs 
 */
export function incrementQueryMetrics(durationMs) {
  const store = asyncLocalStorage.getStore();
  if (store) {
    store.queryCount = (store.queryCount || 0) + 1;
    store.queryDurationMs = (store.queryDurationMs || 0) + durationMs;
  }
}
