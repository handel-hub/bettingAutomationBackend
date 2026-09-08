// @ts-check
import { getPool } from '../../persistence/connection.mjs';

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
      return next();
    }

    // 2. If body is a ProtocolEnvelopeV2, validate it
    if (req.body && req.body.version === 2 && req.body.signature && req.body.machineId) {
      const { envelopeValidator } = await import('./envelope-validator.mjs');
      return envelopeValidator(req, res, next);
    }

    const authHeader = req.headers['authorization'];
    const sessionHeader = req.headers['x-session-id'] || req.headers['x-account-id'];
    const pool = getPool();

    let accountId = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      // Look up session
      const sessRes = await pool.query(
        "SELECT account_id FROM sessions WHERE session_id = $1 AND status = 'AUTHENTICATED' AND expires_at > now()",
        [token]
      );
      if (sessRes.rows.length > 0) {
        accountId = sessRes.rows[0].account_id;
      }
    } else if (sessionHeader) {
      // Could be directly an account_id or a session_id
      const sessRes = await pool.query(
        "SELECT account_id FROM sessions WHERE session_id = $1 AND status = 'AUTHENTICATED' AND expires_at > now()",
        [sessionHeader]
      );
      if (sessRes.rows.length > 0) {
        accountId = sessRes.rows[0].account_id;
      } else {
        const accRes = await pool.query('SELECT account_id FROM accounts WHERE account_id = $1', [sessionHeader]);
        if (accRes.rows.length > 0) {
          accountId = accRes.rows[0].account_id;
        }
      }
    }

    // Local dev / test environment fallback ONLY (never in strict production)
    if (!accountId && (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development' || !process.env.NODE_ENV)) {
      const defaultAccRes = await pool.query("SELECT account_id FROM accounts WHERE status = 'ACTIVE' ORDER BY created_at ASC LIMIT 1");
      if (defaultAccRes.rows.length > 0) {
        accountId = defaultAccRes.rows[0].account_id;
      }
    }

    if (!accountId) {
      return res.status(401).json({ error: 'Operator authentication required' });
    }

    // @ts-ignore
    req.accountId = accountId;
    next();
  } catch (err) {
    next(err);
  }
}
