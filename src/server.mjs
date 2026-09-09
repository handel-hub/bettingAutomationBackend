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

// Domain V1 Routers for Betting Automation Control Plane & Cloud
import accountsRouter from './api/routes/accounts.mjs';
import automationRouter from './api/routes/automation.mjs';
import billingRouter from './api/routes/billing.mjs';
import settingsRouter from './api/routes/settings.mjs';
import notificationsRouter from './api/routes/notifications.mjs';
import systemRouter from './api/routes/system.mjs';
import supportRouter from './api/routes/support.mjs';
import { initWebSocketServer } from './websocket/server.mjs';
import http from 'http';

const app = express();

app.use(helmet());
app.use(express.json({
  verify: (req, res, buf) => {
    // @ts-ignore
    req.rawBody = buf;
  }
}));

// Protocol & Authority Mounts (supporting both /api/v1/... and /...)
app.use('/auth', authRouter);
app.use('/api/v1/auth', authRouter);
app.use('/machines', machineRouter);
app.use('/api/v1/machines', machineRouter);
app.use('/sessions', sessionRouter);
app.use('/api/v1/sessions', sessionRouter);
app.use('/authorization', authorizationRouter);
app.use('/api/v1/authorization', authorizationRouter);
app.use('/reconciliation', reconciliationRouter);
app.use('/api/v1/reconciliation', reconciliationRouter);
app.use('/transfers', transferRouter);
app.use('/api/v1/transfers', transferRouter);
app.use('/payments', paymentRouter);
app.use('/api/v1/payments', paymentRouter);
app.use('/api/payments', paymentRouter);
app.use('/admin', adminRouter);
app.use('/api/v1/admin', adminRouter);

// Domain 1-7 Unified /api/v1 Mounts
app.use('/api/v1/accounts', accountsRouter);
app.use('/api/v1/automation', automationRouter);
app.use('/api/v1/billing', billingRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/notifications', notificationsRouter);
app.use('/api/v1/system', systemRouter);
app.use('/api/v1/support', supportRouter);

app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', (req, res) => res.json({ status: 'ready' }));

app.use(errorHandler);

import { startWorker } from './outbox/worker.mjs';
import { initializeJobs } from './jobs/index.mjs';

const config = loadConfig();
const port = config.PORT || 3001;

initializePaymentAdapter(config.PAYSTACK_SECRET_KEY || config.PAYMENT_WEBHOOK_SECRET);

// Create HTTP server to attach both Express and WebSocket
export const httpServer = http.createServer(app);
initWebSocketServer(httpServer);

// Only listen if run directly
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  httpServer.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
    
    // Start background processes
    startWorker();
    initializeJobs();
  });
}

export { app };
