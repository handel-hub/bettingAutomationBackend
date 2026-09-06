// @ts-check
import { Router } from 'express';
import { register } from '../../domain/machine/service.mjs';

const router = Router();

router.post('/register', async (req, res, next) => {
  try {
    // Requires an already authenticated session (PARTIAL or AUTHENTICATED)
    const { installationId, publicKeyHex, descriptor, selfSignature, sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(401).json({ error: 'Session required for registration (INV-08)' });
    }
    
    const machine = await register(installationId, publicKeyHex, descriptor, selfSignature, sessionId);
    res.json({ machineId: machine.machine_id });
  } catch (err) {
    next(err);
  }
});

export default router;
