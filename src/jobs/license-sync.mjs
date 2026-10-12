// @ts-check
import { keygenClient } from '../adapters/keygen/client.mjs';
import { logEvent } from '../domain/audit/service.mjs';

/**
 * Periodically reconcile local licenses with Keygen CE.
 * @param {import('pg').PoolClient} client 
 */
export async function syncLicenses(client) {
  const res = await client.query(`
    SELECT license_id, account_id, keygen_license_id, status 
    FROM licenses 
    WHERE status = 'VALID' 
      AND keygen_license_id IS NOT NULL
  `);

  for (const license of res.rows) {
    try {
      const resp = await keygenClient.request(`/licenses/${license.keygen_license_id}`);
      const remoteStatus = resp.data?.attributes?.status;

      if (remoteStatus === 'ACTIVE' || remoteStatus === 'VALID') {
        await client.query(`
          UPDATE licenses 
          SET last_verified_at = now(), updated_at = now() 
          WHERE license_id = $1
        `, [license.license_id]);
      } else if (remoteStatus && remoteStatus !== 'ACTIVE') {
        const newStatus = remoteStatus === 'EXPIRED' ? 'EXPIRED' : 'SUSPENDED';
        await client.query(`
          UPDATE licenses 
          SET status = $1, updated_at = now() 
          WHERE license_id = $2
        `, [newStatus, license.license_id]);

        await client.query(`
          UPDATE authorizations 
          SET status = 'REVOKED', updated_at = now() 
          WHERE license_id = $1 AND status = 'VALID'
        `, [license.license_id]);

        await client.query(`
          UPDATE machine_session_states
          SET session_generation = session_generation + 1,
              authorization_revision = authorization_revision + 1,
              updated_at = now()
          WHERE account_id = $1
        `, [license.account_id]);

        await client.query(`
          INSERT INTO outbox_events (event_type, payload, idempotency_key)
          VALUES ('LICENSE_REVOKED', $1, $2)
          ON CONFLICT (idempotency_key) DO NOTHING
        `, [
          JSON.stringify({
            scope: 'LICENSE',
            targetId: license.license_id,
            accountId: license.account_id,
            reason: `KEYGEN_${newStatus}`
          }),
          `keygen-sync-${license.license_id}-${newStatus}-${Date.now()}`
        ]);

        await logEvent(client, {
          accountId: license.account_id,
          eventType: 'LICENSE_SUSPENDED',
          severity: 'HIGH',
          actorType: 'SYSTEM',
          actorId: 'license-sync-job',
          result: 'SUCCESS',
          reason: `Keygen CE license status changed to ${remoteStatus}`
        });

        try {
          const { closeWebSocketsForTarget } = await import('../websocket/server.mjs');
          closeWebSocketsForTarget({ accountId: license.account_id });
        } catch {
          // Ignore if WS server not running
        }
      }
    } catch (err) {
      console.warn(`[license-sync] Failed to sync license ${license.license_id}:`, err.message);
    }
  }

  if (res.rowCount > 0) {
    console.log(`[license-sync] Reconciled ${res.rowCount} licenses with Keygen CE`);
  }
}
