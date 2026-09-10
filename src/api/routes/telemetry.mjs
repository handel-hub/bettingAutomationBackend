// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import {
  recordArbitrageAudit,
  listArbitrageAudits,
  recordHeartbeat
} from '../../domain/telemetry/service.mjs';

const router = Router();
router.use(operatorAuth);

// POST /api/v1/telemetry/audit - UP-ACP-AUDIT-LOG Ingestion
router.post('/audit', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await recordArbitrageAudit(accountId, req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/telemetry/audit - Query audit telemetry
router.get('/audit', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const audits = await listArbitrageAudits(accountId, req.query);
    res.json(audits);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/telemetry/heartbeat - UP-ACP-HEARTBEAT Ingestion
router.post('/heartbeat', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await recordHeartbeat(accountId, req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
