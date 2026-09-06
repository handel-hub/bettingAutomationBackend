// @ts-check
import { Router } from 'express';
import { revoke } from '../domain/revocation/service.mjs';

const router = Router();

// Basic admin auth middleware stub
router.use((req, res, next) => {
  const adminToken = req.headers['authorization'];
  if (!adminToken || adminToken !== 'Bearer supersecret_admin') {
    return res.status(401).json({ error: 'ADMIN_AUTH_REQUIRED' });
  }
  next();
});

router.post('/accounts/:id/suspend', async (req, res, next) => {
  try {
    await revoke('ACCOUNT', req.params.id, 'admin_suspension');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/machines/:id/revoke', async (req, res, next) => {
  try {
    await revoke('MACHINE', req.params.id, 'admin_revocation');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/sessions/:id/invalidate', async (req, res, next) => {
  try {
    await revoke('SESSION', req.params.id, 'admin_invalidation');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/licenses/:id/revoke', async (req, res, next) => {
  try {
    await revoke('LICENSE', req.params.id, 'admin_license_revocation');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
