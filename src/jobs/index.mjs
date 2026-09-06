// @ts-check
import { registerJob, startScheduler } from './scheduler.mjs';
import { purgeNonces } from './nonce-purge.mjs';
import { cleanupSessions } from './session-cleanup.mjs';
import { scheduleSubscriptions } from './subscription-scheduler.mjs';
// Add others as needed: transfer-cleanup, audit-verification, license-sync

export function initializeJobs() {
  // 6 scheduled jobs
  registerJob('nonce-purge', 60 * 1000, purgeNonces); // every 1 min
  registerJob('session-cleanup', 5 * 60 * 1000, cleanupSessions); // every 5 mins
  registerJob('subscription-scheduler', 60 * 60 * 1000, scheduleSubscriptions); // every 1 hour
  
  startScheduler();
}
