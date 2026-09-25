// @ts-check
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runWithContext, getContext, updateContext } from '../../utils/context.mjs';
import { rootLogger } from '../../utils/Logger.mjs';
import { metrics } from '../../utils/metrics.mjs';

const httpLogger = rootLogger.child({ component: 'HTTP' });

/**
 * Middleware that establishes request correlation context, traces duration,
 * updates metrics, and logs request completion.
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 * @param {import('express').NextFunction} next 
 */
export function requestTracer(req, res, next) {
  const startTime = performance.now();
  
  // Extract or generate correlation trace ID
  const traceId = (
    req.headers['x-request-id'] ||
    req.headers['x-trace-id'] ||
    req.headers['x-correlation-id'] ||
    (req.body && req.body.nonce) ||
    `req-${crypto.randomUUID()}`
  ).toString();

  // Echo traceId in response header for client diagnostic support
  res.setHeader('x-request-id', traceId);

  // Initialize context store
  const context = {
    traceId,
    route: req.path,
    startTime,
    queryCount: 0,
    queryDurationMs: 0
  };

  runWithContext(context, () => {
    // Intercept response finish event to record completion telemetry
    res.on('finish', () => {
      const elapsedMs = performance.now() - startTime;
      const ctx = getContext() || context;

      // Sync account/session context if attached by downstream middlewares
      // @ts-ignore
      const accountId = req.accountId || ctx.accountId;
      // @ts-ignore
      const machineId = req.machineId || ctx.machineId;
      // @ts-ignore
      const sessionId = req.sessionId || ctx.sessionId;

      const routePath = req.baseUrl ? `${req.baseUrl}${req.route?.path || req.path}` : (req.route?.path || req.path);

      // Record metrics
      metrics.recordHttpRequest(req.method, routePath, res.statusCode, elapsedMs);

      const logData = {
        event: 'http_request_completed',
        method: req.method,
        route: routePath,
        statusCode: res.statusCode,
        durationMs: Math.round(elapsedMs * 100) / 100,
        dbQueries: ctx.queryCount || 0,
        dbDurationMs: Math.round((ctx.queryDurationMs || 0) * 100) / 100,
        ...(accountId ? { accountId } : {}),
        ...(machineId ? { machineId } : {}),
        ...(sessionId ? { sessionId } : {})
      };

      const msg = `HTTP ${req.method} ${routePath} ${res.statusCode} (${elapsedMs.toFixed(1)}ms)`;

      // Health checks log at debug level to prevent log pollution during high-frequency probing
      if (req.path.startsWith('/health/')) {
        httpLogger.debug(logData, msg);
      } else if (res.statusCode >= 500) {
        httpLogger.error(logData, msg);
      } else if (res.statusCode >= 400) {
        httpLogger.warn(logData, msg);
      } else {
        httpLogger.info(logData, msg);
      }
    });

    next();
  });
}
