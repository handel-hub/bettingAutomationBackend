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
    const { envelope, machineId, sessionId, accountId } = req;
    if (!sessionId || !accountId) {
      const err = new Error('UNAUTHORIZED: Active session required for reconciliation');
      // @ts-ignore
      err.status = 401;
      // @ts-ignore
      err.code = 'BE_AUTH_MISSING_SESSION';
      // @ts-ignore
      err.legacyCode = 'UNAUTHORIZED';
      throw err;
    }
    const verifiedMachineId = machineId || envelope.machineId;
    
    const result = await reconcile(
      verifiedMachineId,
      envelope.clientGeneration,
      envelope.clientServerEpoch,
      envelope.payload,
      accountId
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
