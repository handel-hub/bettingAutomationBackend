// @ts-check
import pg from 'pg';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../config/index.mjs';
import { incrementQueryMetrics } from '../utils/context.mjs';
import { rootLogger } from '../utils/Logger.mjs';
import { metrics } from '../utils/metrics.mjs';

const { Pool } = pg;
const dbLogger = rootLogger.child({ component: 'PostgreSQL' });

const SLOW_QUERY_THRESHOLD_MS = 100;
let pool;
let isWrapped = false;

function normalizeSql(text) {
  if (typeof text !== 'string') return 'UNKNOWN_QUERY';
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function installQueryWrappers() {
  if (isWrapped) return;
  isWrapped = true;

  const originalQuery = pg.Client.prototype.query;
  // @ts-ignore
  pg.Client.prototype.query = function(...args) {
    const start = performance.now();
    const queryArg = args[0];
    const sqlText = typeof queryArg === 'string' ? queryArg : (queryArg?.text || 'UNKNOWN_QUERY');
    const normalizedSql = normalizeSql(sqlText);

    // Callback style invocation
    const lastArg = args[args.length - 1];
    if (typeof lastArg === 'function') {
      const cb = lastArg;
      args[args.length - 1] = (err, res) => {
        const elapsed = performance.now() - start;
        incrementQueryMetrics(elapsed);
        if (err) {
          metrics.recordDbError(normalizedSql, err.code || 'UNKNOWN');
          dbLogger.error({
            event: 'db_query_failed',
            query: normalizedSql,
            errCode: err.code,
            durationMs: Math.round(elapsed * 100) / 100,
            err
          }, `Database query failed: ${err.message}`);
        } else {
          metrics.recordDbQuery(normalizedSql, elapsed);
          if (elapsed > SLOW_QUERY_THRESHOLD_MS) {
            dbLogger.warn({
              event: 'db_slow_query',
              query: normalizedSql,
              durationMs: Math.round(elapsed * 100) / 100,
              rowCount: res?.rowCount
            }, `Slow database query detected (${elapsed.toFixed(1)}ms): ${normalizedSql}`);
          }
        }
        return cb(err, res);
      };
      return originalQuery.apply(this, args);
    }

    // Promise style invocation
    const promise = originalQuery.apply(this, args);
    if (promise && typeof promise.then === 'function') {
      return promise
        .then((res) => {
          const elapsed = performance.now() - start;
          incrementQueryMetrics(elapsed);
          metrics.recordDbQuery(normalizedSql, elapsed);
          if (elapsed > SLOW_QUERY_THRESHOLD_MS) {
            dbLogger.warn({
              event: 'db_slow_query',
              query: normalizedSql,
              durationMs: Math.round(elapsed * 100) / 100,
              rowCount: res?.rowCount
            }, `Slow database query detected (${elapsed.toFixed(1)}ms): ${normalizedSql}`);
          }
          return res;
        })
        .catch((err) => {
          const elapsed = performance.now() - start;
          incrementQueryMetrics(elapsed);
          metrics.recordDbError(normalizedSql, err.code || 'UNKNOWN');
          dbLogger.error({
            event: 'db_query_failed',
            query: normalizedSql,
            errCode: err.code,
            durationMs: Math.round(elapsed * 100) / 100,
            err
          }, `Database query failed: ${err.message}`);
          throw err;
        });
    }

    return promise;
  };
}

export function getPool() {
  if (!pool) {
    installQueryWrappers();
    const config = loadConfig();
    pool = new Pool({
      connectionString: config.DATABASE_URL,
    });

    pool.on('error', (err) => {
      dbLogger.error({ event: 'db_pool_error', err }, `Unexpected error on idle PostgreSQL client: ${err.message}`);
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
