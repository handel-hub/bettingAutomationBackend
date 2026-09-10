// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import { getPreludeSnapshot } from '../../domain/prelude/service.mjs';

const router = Router();
router.use(operatorAuth);

// GET /api/v1/prelude - Initial composite business state load (CNT-PRELUDE-01)
router.get('/', async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const snapshot = await getPreludeSnapshot(accountId);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

export default router;
