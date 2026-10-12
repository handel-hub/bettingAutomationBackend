// @ts-check
import { Router } from 'express';
import { renew, logout } from '../../domain/session/service.mjs';
import { envelopeValidator } from '../middleware/envelope-validator.mjs';
import { buildEnvelope } from '../../protocol/envelope.mjs';

const router = Router();

router.use(envelopeValidator); // Requires valid protocol envelope

router.post('/renew', async (req, res, next) => {
  try {
    // @ts-ignore
    const { envelope, machineId } = req;
    const verifiedMachineId = machineId || envelope.machineId;
    
    // Presented generation state is expected in envelope.clientGeneration
    const result = await renew(
      envelope.sessionId, 
      verifiedMachineId, 
      envelope.clientGeneration, 
      envelope.nonce
    );
    
    const payload = {
      ...result,
      responseValidated: true // P-04 Guard field
    };
    
    const signedResponse = await buildEnvelope(payload, result.sessionGeneration || envelope.clientGeneration || 1);
    console.log(`✓ [Session] Renewed session ${envelope.sessionId} (Machine: ${verifiedMachineId}, Gen: ${result.sessionGeneration || envelope.clientGeneration || 1})`);
    res.json(signedResponse);
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    // @ts-ignore
    const { envelope, machineId } = req;
    const verifiedMachineId = machineId || envelope.machineId;
    await logout(envelope.sessionId, verifiedMachineId);
    console.log(`ℹ [Session] Logged out session ${envelope.sessionId} (Machine: ${verifiedMachineId})`);
    const signedResponse = await buildEnvelope({ success: true, loggedOut: true }, 1);
    res.json(signedResponse);
  } catch (err) {
    next(err);
  }
});

export default router;
