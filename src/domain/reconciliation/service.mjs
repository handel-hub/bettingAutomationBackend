// @ts-check
import { withTransaction } from '../../persistence/transaction.mjs';
import { logEvent } from '../audit/service.mjs';

/**
 * Reconcile client's state with Backend's state
 * @param {string} machineId 
 * @param {{session?: number, machine?: number}} presentedGeneration 
 * @returns {Promise<{resolution: string, action: string, serverState: {session: number, machine: number}}>}
 */
export async function reconcile(machineId, presentedGeneration) {
  return withTransaction('READ COMMITTED', async (client) => {
    const res = await client.query('SELECT * FROM machine_session_states WHERE machine_id = $1', [machineId]);
    if (res.rows.length === 0) {
      throw new Error('Machine state not found');
    }
    
    const serverState = res.rows[0];
    const serverSessionGen = Number(serverState.session_generation);
    const serverMachineGen = Number(serverState.machine_generation);
    
    const clientSessionGen = presentedGeneration.session ? Number(presentedGeneration.session) : 0;
    const clientMachineGen = presentedGeneration.machine ? Number(presentedGeneration.machine) : 0;
    
    let resolution = 'MATCH';
    let action = 'NONE';
    
    // Security Requirements: INV-06 (reject generation > stored -> GENERATION_COUNTER_FORGERY)
    if (clientSessionGen > serverSessionGen || clientMachineGen > serverMachineGen) {
      resolution = 'FORGERY_SUSPECTED';
      action = 'REVOKE_MACHINE'; // Or alert, depending on policy
      
      // We log the forgery attempt
      await logEvent(client, {
        machineId,
        accountId: serverState.account_id,
        eventType: 'GENERATION_FORGERY_DETECTED',
        severity: 'CRITICAL',
        actorType: 'SYSTEM',
        result: 'FAILURE',
        reason: 'client_generation_exceeds_server',
        metadata: { clientSessionGen, serverSessionGen, clientMachineGen, serverMachineGen }
      });
      
      // Maybe revoke the machine here
      await client.query('UPDATE machines SET status = \'REVOKED\', revoked_at = now() WHERE machine_id = $1', [machineId]);
      await client.query('UPDATE sessions SET status = \'REVOKED\' WHERE machine_id = $1', [machineId]);
    } 
    // INV-07 (detect generation < stored -> GENERATION_MISMATCH, force reconciliation)
    else if (clientSessionGen < serverSessionGen || clientMachineGen < serverMachineGen) {
      resolution = 'CLIENT_BEHIND';
      action = 'FORCE_SYNC';
    }
    
    return {
      resolution,
      action,
      serverState: {
        session: serverSessionGen,
        machine: serverMachineGen
      }
    };
  });
}
