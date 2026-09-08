// @ts-check
import { withTransaction } from '../../persistence/transaction.mjs';
import { logEvent } from '../audit/service.mjs';

/**
 * Reconcile client's state with Backend's state
 * @param {string} machineId 
 * @param {any} presentedGeneration 
 * @param {number} [clientServerEpoch=1]
 * @param {any} [payload=null]
 * @returns {Promise<{resolution: string, action: string, serverEpoch: number, serverState: {session: number, machine: number}}>}
 */
export async function reconcile(machineId, presentedGeneration, clientServerEpoch = 1, payload = null) {
  return withTransaction('READ COMMITTED', async (client) => {
    const res = await client.query('SELECT * FROM machine_session_states WHERE machine_id = $1', [machineId]);
    if (res.rows.length === 0) {
      throw new Error('Machine state not found');
    }
    
    const serverState = res.rows[0];
    const serverSessionGen = Number(serverState.session_generation);
    const serverMachineGen = Number(serverState.machine_generation);
    
    // Check server trust epoch (CRIT-05)
    let currentServerEpoch = 1;
    try {
      const trustRes = await client.query('SELECT server_trust_version FROM backend_trust_state LIMIT 1');
      if (trustRes.rows.length > 0 && trustRes.rows[0].server_trust_version) {
        currentServerEpoch = Number(trustRes.rows[0].server_trust_version);
      }
    } catch {
      currentServerEpoch = 1;
    }
    
    // Support numeric generation as well as object state
    let clientSessionGen = serverSessionGen;
    let clientMachineGen = serverMachineGen;
    if (typeof presentedGeneration === 'number') {
      clientSessionGen = presentedGeneration;
    } else if (presentedGeneration && typeof presentedGeneration === 'object') {
      clientSessionGen = presentedGeneration.session !== undefined ? Number(presentedGeneration.session) : serverSessionGen;
      clientMachineGen = presentedGeneration.machine !== undefined ? Number(presentedGeneration.machine) : serverMachineGen;
    }
    
    let resolution = 'MATCH';
    let action = 'NONE';
    
    // Security Requirements: INV-06 (reject generation > stored) + CRIT-05 (Server Epoch check for DB restore)
    if (clientSessionGen > serverSessionGen || clientMachineGen > serverMachineGen) {
      if (Number(clientServerEpoch) < currentServerEpoch) {
        // Legitimate database restore detected (CRIT-05): Do not revoke machines!
        resolution = 'DB_RESTORED';
        action = 'FORCE_SYNC';
        
        await logEvent(client, {
          machineId,
          accountId: serverState.account_id,
          eventType: 'ROLLBACK_DETECTED',
          severity: 'MEDIUM',
          actorType: 'SYSTEM',
          result: 'SUCCESS',
          reason: 'server_database_restored_epoch_advanced',
          metadata: { clientServerEpoch, currentServerEpoch, clientSessionGen, serverSessionGen }
        });
      } else {
        // Genuine forgery suspected
        resolution = 'FORGERY_SUSPECTED';
        action = 'REVOKE_MACHINE';
        
        // Log forgery attempt using valid PostgreSQL schema constraint type
        await logEvent(client, {
          machineId,
          accountId: serverState.account_id,
          eventType: 'GENERATION_COUNTER_FORGERY',
          severity: 'CRITICAL',
          actorType: 'SYSTEM',
          result: 'FAILURE',
          reason: 'client_generation_exceeds_server',
          metadata: { clientSessionGen, serverSessionGen, clientMachineGen, serverMachineGen, clientServerEpoch }
        });
        
        await client.query("UPDATE machines SET status = 'REVOKED', revoked_at = now() WHERE machine_id = $1", [machineId]);
        await client.query("UPDATE sessions SET status = 'REVOKED' WHERE machine_id = $1", [machineId]);
      }
    } 
    // INV-07 (detect generation < stored -> GENERATION_MISMATCH, force reconciliation)
    else if (clientSessionGen < serverSessionGen || clientMachineGen < serverMachineGen) {
      resolution = 'CLIENT_BEHIND';
      action = 'FORCE_SYNC';
    }
    
    return {
      resolution,
      action,
      serverEpoch: currentServerEpoch,
      serverState: {
        session: serverSessionGen,
        machine: serverMachineGen
      }
    };
  });
}
