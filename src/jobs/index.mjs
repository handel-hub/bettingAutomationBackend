// @ts-check
import { registerJob, startScheduler } from './scheduler.mjs';
import { purgeNonces } from './nonce-purge.mjs';
import { cleanupSessions } from './session-cleanup.mjs';
import { scheduleSubscriptions } from './subscription-scheduler.mjs';
import { cleanupStaleTransfers } from './transfer-cleanup.mjs';
import { verifyAuditChain } from './audit-verification.mjs';
import { syncLicenses } from './license-sync.mjs';

export function initializeJobs() {
  // 6 scheduled jobs
  registerJob('nonce-purge', 60 * 1000, purgeNonces); // every 1 min
  registerJob('session-cleanup', 5 * 60 * 1000, cleanupSessions); // every 5 mins
  registerJob('subscription-scheduler', 60 * 60 * 1000, scheduleSubscriptions); // every 1 hour
  // FTS Quarantined: registerJob('transfer-cleanup', 60 * 60 * 1000, cleanupStaleTransfers);
  registerJob('audit-verification', 15 * 60 * 1000, verifyAuditChain); // every 15 mins
  registerJob('license-sync', 60 * 60 * 1000, syncLicenses); // every 1 hour
  
  startScheduler();
}
