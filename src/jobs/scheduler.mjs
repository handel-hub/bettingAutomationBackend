// @ts-check
import { performance } from 'node:perf_hooks';
import { getPool } from '../persistence/connection.mjs';
import { rootLogger } from '../utils/Logger.mjs';
import { metrics } from '../utils/metrics.mjs';

const jobLogger = rootLogger.child({ component: 'JobScheduler' });
const jobs = [];
const activeIntervals = [];

/**
 * Register a scheduled job
 * @param {string} name 
 * @param {number} intervalMs 
 * @param {Function} handler 
 */
export function registerJob(name, intervalMs, handler) {
  jobs.push({ name, intervalMs, handler });
}

export function stopScheduler() {
  for (const intervalId of activeIntervals) {
    clearInterval(intervalId);
  }
  activeIntervals.length = 0;
  jobLogger.info({ event: 'scheduler_stopped' }, 'Job scheduler stopped');
}

export function startScheduler() {
  const pool = getPool();
  
  for (const job of jobs) {
    jobLogger.info({
      event: 'job_registered',
      jobName: job.name,
      intervalMs: job.intervalMs
    }, `Registered job ${job.name} (every ${job.intervalMs}ms)`);
    
    const intervalId = setInterval(async () => {
      // 1. Acquire advisory lock using a hash of the job name
      const lockKey = job.name.split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a; }, 0);
      
      const client = await pool.connect();
      let hasLock = false;
      try {
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) as locked', [lockKey]);
        if (!lockRes.rows[0]?.locked) {
          // Another instance is running this job
          return;
        }
        hasLock = true;
        
        // 2. Check last run
        const runRes = await client.query(`
          INSERT INTO scheduled_jobs (job_name, last_run_at, locked_until)
          VALUES ($1, now(), now() + interval '${job.intervalMs} milliseconds')
          ON CONFLICT (job_name) DO UPDATE
          SET last_run_at = now(), locked_until = now() + interval '${job.intervalMs} milliseconds'
          WHERE scheduled_jobs.locked_until IS NULL OR scheduled_jobs.locked_until <= now()
          RETURNING *
        `, [job.name]);
        
        if (runRes.rows.length === 0) {
          // Ran recently / locked
          return;
        }
        
        // 3. Run job with duration measurement
        const start = performance.now();
        let success = false;
        try {
          await job.handler(client);
          await client.query('UPDATE scheduled_jobs SET last_success_at = now() WHERE job_name = $1', [job.name]);
          success = true;
          const elapsed = performance.now() - start;
          metrics.recordJobRun(job.name, elapsed, true);
          jobLogger.info({
            event: 'scheduled_job_completed',
            jobName: job.name,
            durationMs: Math.round(elapsed * 100) / 100
          }, `Job ${job.name} completed successfully in ${elapsed.toFixed(1)}ms`);
        } catch (err) {
          const elapsed = performance.now() - start;
          metrics.recordJobRun(job.name, elapsed, false);
          jobLogger.error({
            event: 'scheduled_job_failed',
            jobName: job.name,
            durationMs: Math.round(elapsed * 100) / 100,
            err
          }, `Job ${job.name} failed (${elapsed.toFixed(1)}ms): ${err.message}`);
        }
      } catch (err) {
        jobLogger.error({
          event: 'scheduler_error',
          jobName: job.name,
          err
        }, `Error in scheduler for ${job.name}: ${err.message}`);
      } finally {
        if (hasLock) {
          try {
            await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
          } catch (unlockErr) {
            jobLogger.error({
              event: 'advisory_unlock_failed',
              jobName: job.name,
              unlockErr
            }, `Failed to release advisory lock for ${job.name}: ${unlockErr.message}`);
          }
        }
        client.release();
      }
    }, job.intervalMs);

    activeIntervals.push(intervalId);
  }
}
