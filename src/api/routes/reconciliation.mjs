// @ts-check
import { Router } from 'express';
import { reconcile } from '../../domain/reconciliation/service.mjs';
import { envelopeValidator } from '../middleware/envelope-validator.mjs';

const router = Router();

router.use(envelopeValidator);

router.post('/sync', async (req, res, next) => {
  try {
    const { envelope } = req;
    
    const result = await reconcile(
      envelope.machineId,
      envelope.clientGeneration
    );
    
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
