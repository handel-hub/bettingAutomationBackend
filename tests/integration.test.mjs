// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { sign } from '../src/crypto/ed25519.mjs';

test('End-to-End Integration Flow: Auth -> Machine Registration -> Full Auth -> Paystack Checkout', async (t) => {
  // 1. Initial Login (Unregistered Machine -> PARTIAL Session)
  const loginRes = await fetch('http://localhost:3000/auth/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'tester@bettingautomation.com',
      password: 'Password123!'
    })
  });
  assert.strictEqual(loginRes.status, 200, 'Auth init should return 200');
  const loginEnvelope = await loginRes.json();
  assert.strictEqual(loginEnvelope.payload.status, 'PARTIAL', 'Unregistered login should yield PARTIAL status');
  const partialSessionId = loginEnvelope.payload.sessionId;
  assert.ok(partialSessionId, 'PARTIAL session ID must exist');

  // 2. Generate Client Ed25519 Key and Self-Sign Installation ID
  const clientKeyPair = crypto.generateKeyPairSync('ed25519');
  const spki = clientKeyPair.publicKey.export({ type: 'spki', format: 'der' });
  const clientPubHex = spki.subarray(spki.length - 32).toString('hex');
  const installationId = crypto.randomUUID();
  const selfSig = sign(clientKeyPair.privateKey, Buffer.from(installationId, 'utf8'));

  // 3. Register Machine under the PARTIAL Session
  const regRes = await fetch('http://localhost:3000/machines/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      installationId,
      publicKeyHex: clientPubHex,
      descriptor: { os: 'Windows_NT', arch: 'x64', hostname: 'test-node-automated' },
      selfSignature: selfSig,
      sessionId: partialSessionId
    })
  });
  assert.strictEqual(regRes.status, 200, 'Machine registration should succeed');
  const regData = await regRes.json();
  assert.ok(regData.machineId, 'Machine ID must be returned on registration');
  const machineId = regData.machineId;

  // 4. Authenticate again with the registered machineId -> Full AUTHENTICATED Session
  const fullAuthRes = await fetch('http://localhost:3000/auth/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'tester@bettingautomation.com',
      password: 'Password123!',
      machineId
    })
  });
  assert.strictEqual(fullAuthRes.status, 200, 'Full auth init should return 200');
  const fullAuthEnvelope = await fullAuthRes.json();
  assert.strictEqual(fullAuthEnvelope.payload.status, 'AUTHENTICATED', 'Registered machine auth must yield AUTHENTICATED status');
  assert.ok(fullAuthEnvelope.signatures['1'], 'Response must be signed with Backend Key version 1');

  // 5. Payment Checkout Flow with Paystack
  const checkoutRes = await fetch('http://localhost:3000/payments/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: '9d627694-537d-4221-bafa-cf1f163c6bdc',
      planId: 'starter_monthly',
      returnUrl: 'http://localhost:3000/callback'
    })
  });
  assert.strictEqual(checkoutRes.status, 200, 'Paystack checkout should return 200');
  const checkoutData = await checkoutRes.json();
  assert.ok(checkoutData.checkoutUrl.startsWith('https://checkout.paystack.com/'), 'Must return a valid Paystack checkout URL');
});
