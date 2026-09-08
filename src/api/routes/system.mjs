// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import {
  getSystemVersionInfo,
  restartAndUpdate
} from '../../domain/system/service.mjs';

const router = Router();
router.use(operatorAuth);

// GET /api/v1/system/version
router.get('/version', async (req, res, next) => {
  try {
    const info = await getSystemVersionInfo();
    res.json(info);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/system/restart-and-update
router.post('/restart-and-update', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await restartAndUpdate(accountId, req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
