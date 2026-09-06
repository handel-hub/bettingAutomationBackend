// @ts-check
import crypto from 'crypto';

const secretKey = 'sk_test_b108149a3582baf55b1bcf0d356934f77e6bdbc5';

async function testDeclinedPaymentWebhook() {
  console.log('Sending simulated charge.failed / declined webhook to server...');

  const failedPayload = {
    event: 'charge.failed',
    id: `evt_failed_${Date.now()}`,
    data: {
      id: 99887766,
      status: 'failed',
      reference: `ref_declined_${Date.now()}`,
      amount: 500000,
      gateway_response: 'Declined: Insufficient Funds',
      channel: 'card',
      metadata: {
        account_id: '9d627694-537d-4221-bafa-cf1f163c6bdc',
        plan_id: 'starter_monthly'
      }
    }
  };

  const rawBody = JSON.stringify(failedPayload);
  const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');

  const res = await fetch('http://localhost:3000/api/payments/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-paystack-signature': signature
    },
    body: rawBody
  });

  console.log('Webhook Ingestion Status:', res.status, await res.text());

  // Wait 6 seconds for Outbox Worker to claim and process the failure event
  console.log('Waiting for Outbox Worker to process failure...');
  await new Promise((r) => setTimeout(r, 6000));
}

testDeclinedPaymentWebhook().catch(console.error);
