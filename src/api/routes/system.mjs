// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import { verifyAdminSession } from '../../admin/service.mjs';
import { getPool } from '../../persistence/connection.mjs';
import {
  getSystemVersionInfo,
  restartAndUpdate
} from '../../domain/system/service.mjs';

const router = Router();

// GET /api/v1/system/version
router.get('/version', operatorAuth, async (req, res, next) => {
  try {
    const info = await getSystemVersionInfo();
    res.json(info);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/system/restart-and-update (Requires SUPER_ADMIN or CAP_UPDATE_INSTALL / CAP_SYSTEM_UPDATE)
router.post('/restart-and-update', async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      try {
        const admin = await verifyAdminSession(authHeader, 'SUPER_ADMIN');
        const result = await restartAndUpdate(admin.adminId, req.body || {});
        return res.json(result);
      } catch {
        // Fall through to operatorAuth + capability check
      }
    }

    await new Promise((resolve, reject) => {
      operatorAuth(req, res, (err) => (err ? reject(err) : resolve(null)));
    });

    // @ts-ignore
    const accountId = req.accountId;
    const pool = getPool();
    const licRes = await pool.query(
      `SELECT capabilities FROM licenses
       WHERE account_id = $1 AND status = 'VALID' AND (expires_at IS NULL OR expires_at > now())
       ORDER BY issued_at DESC LIMIT 1`,
      [accountId]
    );
    const caps = Array.isArray(licRes.rows[0]?.capabilities) ? licRes.rows[0].capabilities : [];
    if (!caps.includes('CAP_UPDATE_INSTALL') && !caps.includes('CAP_SYSTEM_UPDATE')) {
      return res.status(403).json({
        error: {
          code: 'BE_PERM_ENTITLEMENT_EXCEEDED',
          legacyCode: 'FORBIDDEN',
          message: 'CAP_UPDATE_INSTALL capability or SUPER_ADMIN role required to trigger system restart and update'
        }
      });
    }

    const result = await restartAndUpdate(accountId, req.body || {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
