// @ts-check
import { Router } from 'express';
import { authenticate } from '../../app/authenticate.mjs';
import { buildEnvelope } from '../../protocol/envelope.mjs';

const router = Router();

router.post('/init', async (req, res, next) => {
  try {
    const payload = (req.body && req.body.payload && typeof req.body.payload === 'object') ? req.body.payload : req.body;
    const { email, password, machineId, protocolVersion, clientNonce } = payload;
    
    if (!email || !password) {
      const err = new Error('Missing credentials');
      err.status = 400;
      throw err;
    }
    
    const authResult = await authenticate(
      email,
      password,
      machineId || null,
      protocolVersion || 2,
      clientNonce || 'dummy'
    );
    
    const responsePayload = {
      ...authResult,
      nonceValidated: true
    };
    
    const generationNum = Number(authResult.sessionGeneration || 1);
    const signedResponse = await buildEnvelope(responsePayload, generationNum);
    
    console.log(`✓ [Auth] Operator "${email}" logged in successfully (Session: ${authResult.sessionId}, Status: ${authResult.status}, Machine: ${machineId || 'none'})`);

    res.json({
      ...signedResponse,
      ...responsePayload
    });
  } catch (err) {
    const payload = (req.body && req.body.payload && typeof req.body.payload === 'object') ? req.body.payload : req.body;
    console.warn(`⚠ [Auth] Login failed for "${payload?.email || 'unknown'}": ${err.message}`);
    next(err);
  }
});

router.post('/register', async (req, res, next) => {
  try {
    const payload = (req.body && req.body.payload && typeof req.body.payload === 'object') ? req.body.payload : req.body;
    const { email, password, name, machineId, protocolVersion, clientNonce } = payload || {};

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      const err = /** @type {any} */ (new Error('A valid email address is required'));
      err.status = 400;
      err.code = 'INVALID_EMAIL';
      throw err;
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      const err = /** @type {any} */ (new Error('Password must be at least 8 characters'));
      err.status = 400;
      err.code = 'WEAK_PASSWORD';
      throw err;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const { getPool } = await import('../../persistence/connection.mjs');
    const { hashPassword } = await import('../../crypto/hashing.mjs');
    const pool = getPool();

    const existing = await pool.query('SELECT account_id FROM accounts WHERE LOWER(email) = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      const err = /** @type {any} */ (new Error('An account with this email already exists'));
      err.status = 409;
      err.code = 'ACCOUNT_ALREADY_EXISTS';
      throw err;
    }

    const passwordHash = await hashPassword(password);
    const insertRes = await pool.query(
      `INSERT INTO accounts (email, credentials_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING account_id`,
      [normalizedEmail, passwordHash]
    );
    const accountId = insertRes.rows[0].account_id;

    const operatorName = (name && typeof name === 'string' && name.trim())
      ? name.trim()
      : normalizedEmail.split('@')[0];

    await pool.query(
      `INSERT INTO operator_settings (account_id, name)
       VALUES ($1, $2)
       ON CONFLICT (account_id) DO NOTHING`,
      [accountId, operatorName]
    );

    const authResult = await authenticate(
      normalizedEmail,
      password,
      machineId || null,
      protocolVersion || 2,
      clientNonce || 'register_init'
    );

    const responsePayload = {
      ...authResult,
      nonceValidated: true
    };

    const generationNum = Number(authResult.sessionGeneration || 1);
    const signedResponse = await buildEnvelope(responsePayload, generationNum);

    console.log(`✓ [Auth] Operator "${normalizedEmail}" registered & logged in (Account: ${accountId}, Session: ${authResult.sessionId})`);

    res.status(201).json({
      ...signedResponse,
      ...responsePayload
    });
  } catch (err) {
    next(err);
  }
});

export default router;
