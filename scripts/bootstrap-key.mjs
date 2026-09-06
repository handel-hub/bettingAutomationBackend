// @ts-check
import crypto from 'crypto';
import { getPool } from '../src/persistence/connection.mjs';

async function bootstrapKey() {
  const pool = getPool();
  const keyPair = crypto.generateKeyPairSync('ed25519');
  
  // SPKI DER has 12-byte header for Ed25519; the last 32 bytes is raw public key (64 hex characters)
  const spkiBuffer = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  const rawPubBuffer = spkiBuffer.subarray(spkiBuffer.length - 32);
  const pubHex = rawPubBuffer.toString('hex');
  
  await pool.query(`
    INSERT INTO backend_keys (key_version, public_key_hex, status, activated_at)
    VALUES (1, $1, 'ACTIVE', now())
    ON CONFLICT (key_version) DO UPDATE SET public_key_hex = EXCLUDED.public_key_hex, status = 'ACTIVE';
  `, [pubHex]);
  
  console.log(`✓ Active Backend Key Bootstrapped (version 1, hex: ${pubHex})`);
  await pool.end();
}

bootstrapKey();
