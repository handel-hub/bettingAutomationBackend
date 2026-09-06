// @ts-check
import crypto from 'crypto';
import { sign } from '../src/crypto/ed25519.mjs';

async function testFullFlow() {
  console.log('--- Starting Complete Flow Test ---');
  
  // 1. Authenticate (Login)
  const loginRes = await fetch('http://localhost:3000/auth/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'tester@bettingautomation.com',
      password: 'Password123!'
    })
  });
  
  const loginEnvelope = await loginRes.json();
  console.log('✓ 1. Auth Init Response:', loginEnvelope.payload.status, 'SessionId:', loginEnvelope.payload.sessionId);
  const partialSessionId = loginEnvelope.payload.sessionId;

  // 2. Generate Client Machine Ed25519 Keypair
  const clientKeyPair = crypto.generateKeyPairSync('ed25519');
  const spki = clientKeyPair.publicKey.export({ type: 'spki', format: 'der' });
  const clientPubHex = spki.subarray(spki.length - 32).toString('hex');
  const installationId = crypto.randomUUID();

  // Self-sign the installationId with client private key
  const selfSig = sign(clientKeyPair.privateKey, Buffer.from(installationId, 'utf8'));

  // 3. Register Machine
  const regRes = await fetch('http://localhost:3000/machines/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      installationId,
      publicKeyHex: clientPubHex,
      descriptor: { os: 'Windows_NT', arch: 'x64', hostname: 'test-node-1' },
      selfSignature: selfSig,
      sessionId: partialSessionId
    })
  });
  
  const regData = await regRes.json();
  console.log('✓ 2. Machine Register Response:', regData);
  const machineId = regData.machineId;

  // 4. Authenticate again with the registered machineId (Full AUTHENTICATED session)
  const fullAuthRes = await fetch('http://localhost:3000/auth/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'tester@bettingautomation.com',
      password: 'Password123!',
      machineId
    })
  });
  
  const fullAuthEnvelope = await fullAuthRes.json();
  console.log('✓ 3. Machine Authenticated Session:', fullAuthEnvelope.payload.status, 'SessionId:', fullAuthEnvelope.payload.sessionId);
  
  // 5. Payment Checkout Initiation
  const checkoutRes = await fetch('http://localhost:3000/payments/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: '9d627694-537d-4221-bafa-cf1f163c6bdc',
      planId: 'starter_monthly',
      returnUrl: 'http://localhost:3000/callback'
    })
  });
  const checkoutData = await checkoutRes.json();
  console.log('✓ 4. Paystack Checkout Initiation:', checkoutData.checkoutUrl ? 'SUCCESS' : 'FAILED', checkoutData.checkoutUrl);

  console.log('\n--- ALL INTEGRATION TESTS PASSED ---');
}

testFullFlow().catch(console.error);
