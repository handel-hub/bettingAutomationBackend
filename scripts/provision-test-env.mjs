// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapDevAccounts } from '../src/persistence/bootstrap.mjs';
import { closePool } from '../src/persistence/connection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runProvisioning() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TEST_PROVISIONING !== 'true') {
    console.error('[Provision] Refusing to provision test accounts in NODE_ENV=production without ALLOW_TEST_PROVISIONING=true');
    process.exit(1);
  }

  try {
    const scenarioArg = process.argv.find(a => a.startsWith('--scenario='));
    const scenario = scenarioArg ? scenarioArg.split('=')[1] : 'all';

    console.log(`[Provision] Provisioning test environment (scenario=${scenario})...`);
    const result = await bootstrapDevAccounts({ scenario });

    console.log(`✓ Active Backend KMS Public Key (v1): ${result.publicKeyHex}`);
    console.log(`✓ Provisioned operator accounts: ${result.accounts.join(', ')}`);

    // Synchronize PINNED_BACKEND_PUBKEY_HEX into Control Plane .env if sibling directory exists
    const acpDir = path.resolve(__dirname, '../../bettingAutomationControlPlane');
    if (fs.existsSync(acpDir)) {
      const acpEnvPath = path.join(acpDir, '.env');
      let envContent = '';
      if (fs.existsSync(acpEnvPath)) {
        envContent = fs.readFileSync(acpEnvPath, 'utf8');
      }

      const updates = {
        PINNED_BACKEND_PUBKEY_HEX: result.publicKeyHex,
        BACKEND_URL: process.env.BACKEND_URL || 'http://127.0.0.1:3001'
      };

      for (const [key, value] of Object.entries(updates)) {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
          envContent = envContent.trimEnd() + (envContent ? '\n' : '') + `${key}=${value}\n`;
        }
      }

      fs.writeFileSync(acpEnvPath, envContent, 'utf8');
      console.log(`✓ Synchronized PINNED_BACKEND_PUBKEY_HEX and BACKEND_URL to ${acpEnvPath}`);
    }
  } catch (err) {
    console.error('[Provision] Failed:', err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

runProvisioning();
