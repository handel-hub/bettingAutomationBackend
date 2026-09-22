// @ts-check
import { bootstrapDevAccounts } from '../src/persistence/bootstrap.mjs';
import { closePool } from '../src/persistence/connection.mjs';

async function seed() {
  try {
    console.log('Seeding development operator & test accounts into betting_automation...');
    await bootstrapDevAccounts();
    console.log('✓ Seeding completed successfully!');
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

seed();
