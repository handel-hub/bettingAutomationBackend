// @ts-check
import { getPool } from '../../persistence/connection.mjs';
import { rootLogger } from '../../utils/Logger.mjs';
import { updateContext } from '../../utils/context.mjs';

const authLogger = rootLogger.child({ component: 'OperatorAuth' });

/**
 * Authentication middleware for /api/v1/... endpoints.
 * Resolves accountId from:
 * 1. Bearer token / Session ID in Authorization header
 * 2. x-account-id or x-session-id header
 * 3. Fallback to active registered account in local single-operator environment
 * 
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 * @param {import('express').NextFunction} next 
 */
export async function operatorAuth(req, res, next) {
  try {
    // 1. If already validated by envelopeValidator
    if (req.accountId) {
      updateContext({ accountId: req.accountId, machineId: req.machineId, sessionId: req.sessionId });
      return next();
    }

    // 2. If body is a ProtocolEnvelopeV2, validate it and require an authenticated session
    if (req.body && req.body.version === 2 && req.body.signature && req.body.machineId) {
      const { envelopeValidator } = await import('./envelope-validator.mjs');
      return envelopeValidator(req, res, (err) => {
        if (err) return next(err);
        if (!req.accountId || !req.sessionId) {
          authLogger.warn({
            event: 'operator_auth_rejected',
            reason: 'envelope_missing_session',
            machineId: req.machineId
          }, 'Operator authentication rejected: signed envelope lacks authenticated session');
          return res.status(401).json({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Operator authentication required. Authenticated session required in signed envelope.'
            }
          });
        }
        updateContext({ accountId: req.accountId, machineId: req.machineId, sessionId: req.sessionId });
        return next();
      });
    }

    const authHeader = req.headers['authorization'];
    const sessionHeader = req.headers['x-session-id'];
    const pool = getPool();

    let accountId = null;
    let sessionId = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      sessionId = authHeader.slice(7).trim();
    } else if (typeof sessionHeader === 'string') {
      sessionId = sessionHeader.trim();
    }

    if (sessionId) {
      const sessRes = await pool.query(`
        SELECT s.account_id, s.machine_id, s.status, s.expires_at,
               a.status as account_status, m.status as machine_status
        FROM sessions s
        JOIN accounts a ON s.account_id = a.account_id
        LEFT JOIN machines m ON s.machine_id = m.machine_id
        WHERE s.session_id = $1 AND s.status = 'AUTHENTICATED' AND s.expires_at > now()
      `, [sessionId]);

      if (sessRes.rows.length > 0) {
        const row = sessRes.rows[0];
        if (row.account_status !== 'ACTIVE') {
          authLogger.warn({
            event: 'operator_auth_rejected',
            reason: 'account_not_active',
            accountStatus: row.account_status,
            accountId: row.account_id,
            sessionId
          }, 'Operator authentication rejected: account is not active');
          const status = row.account_status === 'LOCKED' ? 423 : 403;
          const code = row.account_status === 'LOCKED' ? 'ACCOUNT_LOCKED' : 'ACCOUNT_INACTIVE';
          return res.status(status).json({
            error: { code, message: `Account is ${row.account_status.toLowerCase()}` }
          });
        }
        if (row.machine_id && row.machine_status && row.machine_status !== 'REGISTERED') {
          authLogger.warn({
            event: 'operator_auth_rejected',
            reason: 'machine_not_registered',
            machineStatus: row.machine_status,
            accountId: row.account_id,
            machineId: row.machine_id,
            sessionId
          }, 'Operator authentication rejected: machine is not registered');
          return res.status(403).json({
            error: { code: 'MACHINE_REVOKED', message: 'Machine is revoked or inactive' }
          });
        }
        accountId = row.account_id;
        // @ts-ignore
        req.sessionId = sessionId;
        // @ts-ignore
        req.machineId = row.machine_id || undefined;
      }
    }

    if (!accountId) {
      authLogger.warn({
        event: 'operator_auth_rejected',
        reason: sessionId ? 'session_expired_or_invalid' : 'missing_credentials',
        hasAuthHeader: Boolean(authHeader),
        hasSessionHeader: Boolean(sessionHeader)
      }, 'Operator authentication required: invalid or missing session');
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Operator authentication required. Valid session Bearer token or signed envelope required.'
        }
      });
    }

    // @ts-ignore
    req.accountId = accountId;
    updateContext({ accountId, machineId: req.machineId, sessionId: sessionId || undefined });
    next();
  } catch (err) {
    next(err);
  }
}
