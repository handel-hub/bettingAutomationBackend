// @ts-check
import { Router } from 'express';
import { renew, logout } from '../../domain/session/service.mjs';
import { envelopeValidator } from '../middleware/envelope-validator.mjs';

const router = Router();

router.use(envelopeValidator); // Requires valid protocol envelope

router.post('/renew', async (req, res, next) => {
  try {
    const { envelope } = req;
    
    // Presented generation state is expected in envelope.clientGeneration
    const result = await renew(
      envelope.sessionId, 
      envelope.machineId, 
      envelope.clientGeneration, 
      envelope.nonce
    );
    
    res.json({
      ...result,
      responseValidated: true // P-04 Guard field
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const { envelope } = req;
    await logout(envelope.sessionId, envelope.machineId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
