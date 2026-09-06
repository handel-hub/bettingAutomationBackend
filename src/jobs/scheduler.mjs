// @ts-check
import { getPool } from '../persistence/connection.mjs';

const jobs = [];

/**
 * Register a scheduled job
 * @param {string} name 
 * @param {number} intervalMs 
 * @param {Function} handler 
 */
export function registerJob(name, intervalMs, handler) {
  jobs.push({ name, intervalMs, handler });
}

export function startScheduler() {
  const pool = getPool();
  
  for (const job of jobs) {
    console.log(`Registered job ${job.name} (every ${job.intervalMs}ms)`);
    
    setInterval(async () => {
      // 1. Acquire advisory lock using a hash of the job name
      const lockKey = job.name.split('').reduce((a,b)=>{a=((a<<5)-a)+b.charCodeAt(0);return a&a},0);
      
      const client = await pool.connect();
      try {
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) as locked', [lockKey]);
        if (!lockRes.rows[0].locked) {
          // Another instance is running this job
          return;
        }
        
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
          await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
          return;
        }
        
        // 3. Run job
        try {
          await job.handler(client);
          await client.query('UPDATE scheduled_jobs SET last_success_at = now() WHERE job_name = $1', [job.name]);
        } catch (err) {
          console.error(`Job ${job.name} failed:`, err);
        }
        
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      } catch (err) {
        console.error(`Error in scheduler for ${job.name}:`, err);
      } finally {
        client.release();
      }
    }, job.intervalMs);
  }
}
