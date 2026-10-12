// @ts-check
import { Router } from 'express';
import { revoke } from '../domain/revocation/service.mjs';
import { adminLogin, verifyAdminSession } from './service.mjs';
import { ipRateLimiter, authAccountRateLimiter } from '../api/middleware/rate-limiter.mjs';

const router = Router();

// Public admin login route
router.post('/login', ipRateLimiter, authAccountRateLimiter, async (req, res, next) => {
  try {
    const { email, password, totpCode } = req.body;
    if (!email || !password || !totpCode) {
      return res.status(400).json({ error: 'Missing email, password, or totpCode' });
    }
    const result = await adminLogin(email, password, totpCode);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Admin authentication middleware
export const requireAdmin = (requiredRole = 'SUPPORT') => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers['authorization'];
      if (!authHeader) {
        return res.status(401).json({ error: 'ADMIN_AUTH_REQUIRED' });
      }
      const admin = await verifyAdminSession(authHeader, requiredRole);
      // @ts-ignore
      req.admin = admin;
      next();
    } catch (err) {
      next(err);
    }
  };
};

router.get('/overview', requireAdmin('SUPPORT'), (req, res) => {
  res.json({ status: 'OK' });
});

router.post('/accounts/:id/suspend', requireAdmin('SUPER_ADMIN'), async (req, res, next) => {
  try {
    // @ts-ignore
    await revoke('ACCOUNT', req.params.id, 'admin_suspension', { type: 'ADMIN', id: req.admin.adminId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/machines/:id/revoke', requireAdmin('SUPPORT'), async (req, res, next) => {
  try {
    // @ts-ignore
    await revoke('MACHINE', req.params.id, 'admin_revocation', { type: 'ADMIN', id: req.admin.adminId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/sessions/:id/invalidate', requireAdmin('SUPPORT'), async (req, res, next) => {
  try {
    // @ts-ignore
    await revoke('SESSION', req.params.id, 'admin_invalidation', { type: 'ADMIN', id: req.admin.adminId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/licenses/:id/revoke', requireAdmin('LICENSE_ADMIN'), async (req, res, next) => {
  try {
    // @ts-ignore
    await revoke('LICENSE', req.params.id, 'admin_license_revocation', { type: 'ADMIN', id: req.admin.adminId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
