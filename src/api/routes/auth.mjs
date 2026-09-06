// @ts-check
import { Router } from 'express';
import { authenticate } from '../../app/authenticate.mjs';
import { buildEnvelope } from '../../protocol/envelope.mjs';

const router = Router();

router.post('/init', async (req, res, next) => {
  try {
    const { email, password, machineId, protocolVersion, clientNonce } = req.body;
    
    if (!email || !password) {
      const err = new Error('Missing credentials');
      err.status = 400;
      throw err;
    }
    
    const authResult = await authenticate(email, password, machineId || null, protocolVersion || 2, clientNonce || 'dummy');
    
    // Phase 6: response additionally carries nonceValidated: true
    const responsePayload = {
      ...authResult,
      nonceValidated: true
    };
    
    // Usually auth/init doesn't have a machine public key yet to sign to, 
    // unless it's a registered machine. The envelope builder for AUTH_RESULT 
    // might just use the backend active key to sign the result.
    const signedResponse = await buildEnvelope(responsePayload, { session: authResult.sessionGeneration || 1, machine: 1 });
    
    res.json(signedResponse);
  } catch (err) {
    next(err);
  }
});

export default router;
