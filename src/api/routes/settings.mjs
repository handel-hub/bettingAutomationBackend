// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import {
  getSettingsSnapshot,
  processSettingsIntent
} from '../../domain/settings/service.mjs';
import { broadcast } from '../../websocket/server.mjs';

const router = Router();
router.use(operatorAuth);

// GET /api/v1/settings - Current snapshot
router.get('/', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const snapshot = await getSettingsSnapshot(accountId);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/settings/intent - Intent pattern execution
router.post('/intent', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const ack = await processSettingsIntent(accountId, req.body);

    if (ack.status === 'ACCEPTED') {
      const fresh = await getSettingsSnapshot(accountId);
      broadcast('settings:snapshot', fresh, accountId);
    }

    res.json(ack);
  } catch (err) {
    next(err);
  }
});

export default router;
