// @ts-check
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { loadConfig } from './config/index.mjs';
import { errorHandler } from './api/middleware/error-handler.mjs';

import paymentRouter from './api/routes/payments.mjs';
import authRouter from './api/routes/auth.mjs';
import machineRouter from './api/routes/machines.mjs';
import sessionRouter from './api/routes/sessions.mjs';
import authorizationRouter from './api/routes/authorization.mjs';
import reconciliationRouter from './api/routes/reconciliation.mjs';
import transferRouter from './api/routes/transfers.mjs';
import adminRouter from './admin/routes.mjs';
import { initializePaymentAdapter } from './adapters/payment/adapter.mjs';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

// Mount routers
app.use('/auth', authRouter);
app.use('/machines', machineRouter);
app.use('/sessions', sessionRouter);
app.use('/authorization', authorizationRouter);
app.use('/reconciliation', reconciliationRouter);
app.use('/transfers', transferRouter);
app.use('/payments', paymentRouter);
app.use('/api/payments', paymentRouter);
app.use('/admin', adminRouter);
app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', (req, res) => res.json({ status: 'ready' }));

app.use(errorHandler);

import { startWorker } from './outbox/worker.mjs';
import { initializeJobs } from './jobs/index.mjs';

const config = loadConfig();
const port = config.PORT || 3000;

initializePaymentAdapter(config.PAYSTACK_SECRET_KEY || config.PAYMENT_WEBHOOK_SECRET);

app.listen(port, () => {
  console.log(`Backend server listening on port ${port}`);
  
  // Start background processes
  startWorker();
  initializeJobs();
});
