// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import { requireAdmin } from '../../admin/routes.mjs';
import {
  getCustomerCareSnapshot,
  createTicket,
  listTickets,
  submitDiagnostics
} from '../../domain/support/service.mjs';
import crypto from 'crypto';

const router = Router();

// POST /api/v1/support/channels - Upsert support contact channel (Admin only)
router.post('/channels', requireAdmin('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { upsertSupportChannel } = await import('../../domain/support/service.mjs');
    const channel = await upsertSupportChannel(req.body);
    res.status(201).json(channel);
  } catch (err) {
    next(err);
  }
});

router.use(operatorAuth);

// GET /api/v1/support/snapshot
router.get('/snapshot', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const snapshot = await getCustomerCareSnapshot(accountId);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/support/tickets - List tickets
router.get('/tickets', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const tickets = await listTickets(accountId);
    res.json(tickets);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/support/tickets - Create ticket
router.post('/tickets', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await createTicket(accountId, req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/support/attachments - Upload diagnostic attachment
router.post('/attachments', async (req, res, next) => {
  try {
    const fileId = `file-${crypto.randomUUID()}`;
    res.json({
      fileId,
      fileName: 'attachment.log',
      sizeBytes: 1024
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/support/diagnostics - Submit diagnostic report
router.post('/diagnostics', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await submitDiagnostics(accountId, req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/support/channels - List all support contact channels
router.get('/channels', async (req, res, next) => {
  try {
    const { listSupportChannels } = await import('../../domain/support/service.mjs');
    const channels = await listSupportChannels();
    res.json(channels);
  } catch (err) {
    next(err);
  }
});

export default router;
