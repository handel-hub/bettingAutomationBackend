// @ts-check
import { Router } from 'express';
import { register } from '../../domain/machine/service.mjs';
import { listMachinesByAccount, revokeMachine } from '../../domain/machine/repository.mjs';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import { ipRateLimiter } from '../middleware/rate-limiter.mjs';
import { buildEnvelope } from '../../protocol/envelope.mjs';

const router = Router();

// GET /api/v1/machines - List registered machines for authenticated operator
router.get('/', operatorAuth, async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    if (!accountId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }
    const machines = await listMachinesByAccount(null, accountId);
    res.json({ machines });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/machines/:machineId - Explicitly revoke a registered machine
router.delete('/:machineId', operatorAuth, async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    if (!accountId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }
    const { machineId } = req.params;
    await revokeMachine(null, machineId, accountId);
    res.json({ success: true, machineId, status: 'REVOKED' });
  } catch (err) {
    next(err);
  }
});

router.post('/register', ipRateLimiter, async (req, res, next) => {
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
    const responsePayload = {
      machineId: machine.machine_id,
      status: machine.status || 'REGISTERED'
    };
    const signedResponse = await buildEnvelope(responsePayload, 1);

    res.json({
      ...signedResponse,
      ...responsePayload
    });
  } catch (err) {
    next(err);
  }
});

export default router;

