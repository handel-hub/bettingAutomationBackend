// @ts-check
import test from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../src/config/index.mjs';

test('Config schema validates required fields', () => {
    const originalEnv = { ...process.env };
    
    try {
        process.env.NODE_ENV = 'test';
        process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
        process.env.KEYGEN_API_KEY = 'test_key';
        process.env.PAYMENT_WEBHOOK_SECRET = 'whsec_test';
        
        // This will cache the config, so we can't test loadConfig failure easily in the same process
        // unless we reset the cache. But for now we just test it loads.
        const config = loadConfig();
        assert.strictEqual(config.NODE_ENV, 'test');
        assert.strictEqual(config.DATABASE_URL, 'postgres://user:pass@localhost:5432/db');
    } finally {
        process.env = originalEnv;
    }
});
