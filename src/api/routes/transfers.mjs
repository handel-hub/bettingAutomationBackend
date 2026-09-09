// @ts-check
import { Router } from 'express';
import { initialize, uploadChunk, complete, cancel, getStatus } from '../../transfer/service.mjs';
import { operatorAuth } from '../middleware/operator-auth.mjs';

const router = Router();

router.use(operatorAuth);

router.post(['/', '/initialize'], async (req, res, next) => {
  try {
    // @ts-ignore
    const sessionId = req.sessionId || req.envelope?.sessionId;
    if (!sessionId) {
      return res.status(401).json({ error: 'Valid session required for file transfer' });
    }
    const params = (req.body && req.body.payload && typeof req.body.payload === 'object') ? req.body.payload : req.body;
    
    const result = await initialize(sessionId, params);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:remoteSessionId/chunks', async (req, res, next) => {
  try {
    const { remoteSessionId } = req.params;
    const body = (req.body && req.body.payload && typeof req.body.payload === 'object') ? req.body.payload : req.body;
    const { offset, data } = body;
    
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    const result = await uploadChunk(remoteSessionId, offset, buffer);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:remoteSessionId/complete', async (req, res, next) => {
  try {
    const { remoteSessionId } = req.params;
    const result = await complete(remoteSessionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/:remoteSessionId/status', async (req, res, next) => {
  try {
    const { remoteSessionId } = req.params;
    const result = await getStatus(remoteSessionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:remoteSessionId/cancel', async (req, res, next) => {
  try {
    const { remoteSessionId } = req.params;
    await cancel(remoteSessionId);
    res.json({ success: true, status: 'CANCELLED' });
  } catch (err) {
    next(err);
  }
});

export default router;
