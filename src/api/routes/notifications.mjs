// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import {
  listNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllNotifications,
  createNotification
} from '../../domain/notifications/service.mjs';
import { broadcast } from '../../websocket/server.mjs';

const router = Router();
router.use(operatorAuth);

// GET /api/v1/notifications
router.get('/', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { unreadOnly, severity } = req.query;

    const data = await listNotifications(accountId, {
      unreadOnly: unreadOnly === 'true',
      severity: severity ? String(severity) : undefined
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/notifications - Ingest internal notification
router.post('/', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const created = await createNotification(accountId, req.body);

    broadcast('notifications:new', created, accountId);

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/notifications/:id/read
router.patch('/:id/read', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await markAsRead(accountId, req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/notifications/mark-all-read
router.post('/mark-all-read', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await markAllAsRead(accountId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/notifications/clear-all
router.delete('/clear-all', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await clearAllNotifications(accountId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/notifications/:id
router.delete('/:id', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await deleteNotification(accountId, req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
