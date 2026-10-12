// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import { requireAdmin } from '../../admin/routes.mjs';
import {
  getPlatformRegistrySnapshot,
  getPlatformById,
  upsertPlatform,
  updatePlatformStatus
} from '../../domain/platforms/service.mjs';

const router = Router();

// GET /api/v1/platforms (Authenticated operator catalog)
router.get('/', operatorAuth, async (req, res, next) => {
  try {
    const snapshot = await getPlatformRegistrySnapshot();
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/platforms/:id
router.get('/:id', operatorAuth, async (req, res, next) => {
  try {
    const platform = await getPlatformById(req.params.id);
    if (!platform) {
      return res.status(404).json({ error: { code: 'PLATFORM_NOT_FOUND', message: 'Platform not found' } });
    }
    res.json(platform);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/platforms - Add/Update platform dynamically (Admin only)
router.post('/', requireAdmin('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const created = await upsertPlatform(req.body);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/platforms/:id/status (Admin only)
router.patch('/:id/status', requireAdmin('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { status, isAvailable } = req.body;
    const ok = await updatePlatformStatus(req.params.id, status, isAvailable);
    if (!ok) {
      return res.status(404).json({ error: { code: 'PLATFORM_NOT_FOUND', message: 'Platform not found' } });
    }
    res.json({ success: true, id: req.params.id, status, isAvailable });
  } catch (err) {
    next(err);
  }
});

export default router;
