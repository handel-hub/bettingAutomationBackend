// @ts-check
import { Router } from 'express';
import { resolve } from '../../domain/authorization/service.mjs';
import { envelopeValidator } from '../middleware/envelope-validator.mjs';
import { buildEnvelope } from '../../protocol/envelope.mjs';

const router = Router();

router.use(envelopeValidator);

router.post('/resolve', async (req, res, next) => {
  try {
    // @ts-ignore
    const { envelope, machineId } = req;
    const verifiedMachineId = machineId || envelope.machineId;
    
    const result = await resolve(
      envelope.sessionId,
      verifiedMachineId,
      envelope.clientGeneration
    );
    
    const payload = {
      ...result,
      backendConfirmed: true // P-04 Guard field
    };
    
    const signedResponse = await buildEnvelope(payload, result.revision || envelope.clientGeneration || 1);
    res.json(signedResponse);
  } catch (err) {
    next(err);
  }
});

export default router;
