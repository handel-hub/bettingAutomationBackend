// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import {
  getAutomationSnapshot,
  updateGlobalConfig,
  toggleBetCycle,
  updateAccountAutomationConfig
} from '../../domain/automation/service.mjs';
import { broadcast } from '../../websocket/server.mjs';

const router = Router();
router.use(operatorAuth);

// GET /api/v1/automation/snapshot
router.get('/snapshot', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const snapshot = await getAutomationSnapshot(accountId);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

// Handler for updating global automation config
const handleConfigUpdate = async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const configValues = req.body.values !== undefined ? req.body.values : req.body;
    const result = await updateGlobalConfig(accountId, req.params.category, configValues);

    broadcast('automation:delta', {
      type: 'CONFIG_UPDATED',
      category: req.params.category,
      values: configValues
    }, accountId);

    res.json(result);
  } catch (err) {
    next(err);
  }
};

// PUT /api/v1/automation/config/:category (Control Plane contract)
router.put('/config/:category', handleConfigUpdate);

// POST /api/v1/automation/config/:category & POST /api/v1/automation/config/global/:category (aliases)
router.post('/config/:category', handleConfigUpdate);
router.post('/config/global/:category', handleConfigUpdate);

// POST /api/v1/automation/accounts/:id/bet-cycle
router.post('/accounts/:id/bet-cycle', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { enabled } = req.body;
    const result = await toggleBetCycle(accountId, req.params.id, Boolean(enabled));

    broadcast('automation:delta', {
      type: 'ACCOUNT_UPDATED',
      accountId: req.params.id,
      partialSnapshot: { betCycleEnabled: Boolean(enabled) }
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/automation/accounts/:id/override
router.post('/accounts/:id/override', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { category, source, values } = req.body;
    const result = await updateAccountAutomationConfig(accountId, req.params.id, category, source, values);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
