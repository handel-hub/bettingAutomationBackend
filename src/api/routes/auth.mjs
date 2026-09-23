// @ts-check
import { Router } from 'express';
import { authenticate } from '../../app/authenticate.mjs';
import { buildEnvelope } from '../../protocol/envelope.mjs';

const router = Router();

router.post('/init', async (req, res, next) => {
  try {
    const payload = (req.body && req.body.payload && typeof req.body.payload === 'object') ? req.body.payload : req.body;
    const { email, password, machineId, protocolVersion, clientNonce } = payload;
    
    if (!email || !password) {
      const err = new Error('Missing credentials');
      err.status = 400;
      throw err;
    }
    
    const authResult = await authenticate(
      email,
      password,
      machineId || null,
      protocolVersion || 2,
      clientNonce || 'dummy'
    );
    
    const responsePayload = {
      ...authResult,
      nonceValidated: true
    };
    
    const generationNum = Number(authResult.sessionGeneration || 1);
    const signedResponse = await buildEnvelope(responsePayload, generationNum);
    
    console.log(`✓ [Auth] Operator "${email}" logged in successfully (Session: ${authResult.sessionId}, Status: ${authResult.status}, Machine: ${machineId || 'none'})`);

    res.json({
      ...signedResponse,
      ...responsePayload
    });
  } catch (err) {
    const payload = (req.body && req.body.payload && typeof req.body.payload === 'object') ? req.body.payload : req.body;
    console.warn(`⚠ [Auth] Login failed for "${payload?.email || 'unknown'}": ${err.message}`);
    next(err);
  }
});

export default router;
