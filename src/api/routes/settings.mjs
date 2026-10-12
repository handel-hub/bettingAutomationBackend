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
    // @ts-ignore
    const currentSessionId = req.sessionId || null;
    const intentBody = (req.body && req.body.payload && typeof req.body.payload === 'object' && req.body.payload.type)
      ? req.body.payload
      : req.body;
    const ack = await processSettingsIntent(accountId, intentBody, { currentSessionId });

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
