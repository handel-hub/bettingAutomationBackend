// @ts-check
import { Router } from 'express';
import { initialize, uploadChunk, complete, cancel } from '../../transfer/service.mjs';
import { envelopeValidator } from '../middleware/envelope-validator.mjs';

const router = Router();

router.use(envelopeValidator);

router.post('/initialize', async (req, res, next) => {
  try {
    const { envelope } = req;
    const { filename, size, hash } = req.body; // or envelope.payload
    
    const result = await initialize(envelope.sessionId, filename, size, hash);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:remoteSessionId/chunks', async (req, res, next) => {
  try {
    const { remoteSessionId } = req.params;
    const { offset, data } = req.body; // In reality, handle binary streams
    
    const buffer = Buffer.from(data, 'base64');
    const result = await uploadChunk(remoteSessionId, offset, buffer);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/:remoteSessionId/complete', async (req, res, next) => {
  try {
    const { remoteSessionId } = req.params;
    await complete(remoteSessionId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:remoteSessionId/cancel', async (req, res, next) => {
  try {
    const { remoteSessionId } = req.params;
    await cancel(remoteSessionId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
