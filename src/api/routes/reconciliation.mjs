// @ts-check
import { Router } from 'express';
import { reconcile } from '../../domain/reconciliation/service.mjs';
import { envelopeValidator } from '../middleware/envelope-validator.mjs';
import { buildEnvelope } from '../../protocol/envelope.mjs';

const router = Router();

router.use(envelopeValidator);

router.post('/sync', async (req, res, next) => {
  try {
    // @ts-ignore
    const { envelope, machineId } = req;
    const verifiedMachineId = machineId || envelope.machineId;
    
    const result = await reconcile(
      verifiedMachineId,
      envelope.clientGeneration,
      envelope.clientServerEpoch,
      envelope.payload
    );
    
    const signedResponse = await buildEnvelope(
      result, 
      result.serverState?.session || envelope.clientGeneration || 1, 
      result.serverEpoch || 1
    );
    res.json(signedResponse);
  } catch (err) {
    next(err);
  }
});

export default router;
