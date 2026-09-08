// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import {
  listBettingAccounts,
  createBettingAccount,
  getBettingAccountById,
  executeAccountAction,
  executeBulkAction
} from '../../domain/betting-accounts/service.mjs';
import { broadcast } from '../../websocket/server.mjs';

const router = Router();
router.use(operatorAuth);

// GET /api/v1/accounts - Paginated & filtered account list
router.get('/', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { offset = 0, limit = 50, sortBy = 'name', sortOrder = 'asc', filterQuery } = req.query;

    const data = await listBettingAccounts(accountId, {
      offset: Number(offset),
      limit: Number(limit),
      sortBy: String(sortBy),
      sortOrder: String(sortOrder),
      filterQuery: filterQuery ? String(filterQuery) : undefined
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/accounts - Register new betting account
router.post('/', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { name, platformDisplayName, accountUsername, accountPassword, tags } = req.body;

    const created = await createBettingAccount(accountId, {
      name,
      platformDisplayName,
      accountUsername,
      accountPassword,
      tags
    });

    // Broadcast account delta
    broadcast('accounts:delta', {
      type: 'ACCOUNT_CREATED',
      partialSnapshot: created
    });

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/accounts/:id - Detailed account profile
router.get('/:id', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const details = await getBettingAccountById(accountId, req.params.id);
    res.json(details);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/accounts/:id/action - Single account action
router.post('/:id/action', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { type } = req.body;

    const result = await executeAccountAction(accountId, req.params.id, type);

    // Broadcast update
    broadcast('accounts:delta', {
      type: 'ACCOUNT_STATUS_CHANGED',
      accountId: req.params.id,
      backendState: result.backendState,
      presentationCategory: result.presentationCategory
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/accounts/bulk-action - Bulk operational action
router.post('/bulk-action', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { type, accountIds } = req.body;

    const result = await executeBulkAction(accountId, type, accountIds || []);

    broadcast('accounts:delta', {
      type: 'BULK_OPERATION_RESULT',
      result
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
