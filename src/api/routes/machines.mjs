// @ts-check
import { Router } from 'express';
import { register } from '../../domain/machine/service.mjs';

const router = Router();

router.post('/register', async (req, res, next) => {
  try {
    const payload = (req.body && req.body.payload && typeof req.body.payload === 'object') ? req.body.payload : req.body;
    const { installationId, publicKeyHex, descriptor, selfSignature } = payload;
    
    // Support sessionId from payload or auth headers if present
    const authHeader = req.headers['authorization'];
    const bearerSession = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.slice(7).trim() : null;
    const sessionId = payload.sessionId || req.headers['x-session-id'] || bearerSession || null;
    
    if (!installationId || !publicKeyHex || !selfSignature) {
      return res.status(400).json({ error: 'Missing installationId, publicKeyHex, or selfSignature' });
    }

    const machine = await register(installationId, publicKeyHex, descriptor, selfSignature, sessionId);
    res.json({
      machineId: machine.machine_id,
      status: machine.status || 'REGISTERED'
    });
  } catch (err) {
    next(err);
  }
});

export default router;
