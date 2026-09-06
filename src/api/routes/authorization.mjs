// @ts-check
import { Router } from 'express';
import { resolve } from '../../domain/authorization/service.mjs';
import { envelopeValidator } from '../middleware/envelope-validator.mjs';

const router = Router();

router.use(envelopeValidator);

router.post('/resolve', async (req, res, next) => {
  try {
    const { envelope } = req;
    
    const result = await resolve(
      envelope.sessionId,
      envelope.machineId,
      envelope.clientGeneration
    );
    
    res.json({
      ...result,
      backendConfirmed: true // P-04 Guard field
    });
  } catch (err) {
    next(err);
  }
});

export default router;
