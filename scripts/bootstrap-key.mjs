// @ts-check
import { getPool } from '../src/persistence/connection.mjs';
import { loadConfig } from '../src/config/index.mjs';
import { deriveKeyPair } from '../src/crypto/kms-adapter.mjs';

async function bootstrapKey() {
  const config = loadConfig();
  const secret = config.KMS_LOCAL_SECRET || 'default_local_dev_secret_32_bytes_long';
  const pool = getPool();
  
  const { publicKeyHex } = deriveKeyPair(secret, 'v1');
  
  await pool.query(`
    INSERT INTO backend_keys (key_version, public_key_hex, status, activated_at)
    VALUES (1, $1, 'ACTIVE', now())
    ON CONFLICT (key_version) DO UPDATE SET public_key_hex = EXCLUDED.public_key_hex, status = 'ACTIVE';
  `, [publicKeyHex]);
  
  console.log(`✓ Active Backend Key Bootstrapped (version 1, hex: ${publicKeyHex})`);
  await pool.end();
}

bootstrapKey();
