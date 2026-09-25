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

    // 2. If body is a ProtocolEnvelopeV2, validate it
    if (req.body && req.body.version === 2 && req.body.signature && req.body.machineId) {
      const { envelopeValidator } = await import('./envelope-validator.mjs');
      return envelopeValidator(req, res, next);
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
        SELECT s.account_id, s.status, s.expires_at, a.status as account_status
        FROM sessions s
        JOIN accounts a ON s.account_id = a.account_id
        WHERE s.session_id = $1 AND s.status = 'AUTHENTICATED' AND s.expires_at > now()
      `, [sessionId]);

      if (sessRes.rows.length > 0) {
        if (sessRes.rows[0].account_status === 'LOCKED') {
          authLogger.warn({
            event: 'operator_auth_rejected',
            reason: 'account_locked',
            accountId: sessRes.rows[0].account_id,
            sessionId
          }, 'Operator authentication rejected: account locked');
          return res.status(423).json({
            error: { code: 'ACCOUNT_LOCKED', message: 'Account is locked' }
          });
        }
        accountId = sessRes.rows[0].account_id;
        // @ts-ignore
        req.sessionId = sessionId;
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
    updateContext({ accountId, sessionId: sessionId || undefined });
    next();
  } catch (err) {
    next(err);
  }
}
