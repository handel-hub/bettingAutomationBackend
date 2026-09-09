// @ts-check
import { keygenClient } from './client.mjs';
import { getPool } from '../../persistence/connection.mjs';

/**
 * Licensing Provider Adapter implementing the LicensingProvider port.
 */
export class KeygenAdapter {
  constructor(client = keygenClient) {
    this.client = client;
  }

  /**
   * Validate a license key
   * @param {string} licenseKey 
   * @returns {Promise<{ valid: boolean; status: string }>}
   */
  async validateLicense(licenseKey) {
    try {
      const res = await this.client.validateKey(licenseKey);
      const valid = res.data?.attributes?.status === 'ACTIVE' || res.meta?.valid === true;
      return { valid, status: valid ? 'VALID' : 'INVALID' };
    } catch {
      return { valid: false, status: 'INVALID' };
    }
  }

  /**
   * Activate machine on license
   * @param {string} licenseId 
   * @param {string} machineFingerprint 
   */
  async activateMachine(licenseId, machineFingerprint) {
    return this.client.activateMachine(licenseId, machineFingerprint);
  }

  /**
   * Deactivate machine on license
   * @param {string} machineId 
   */
  async deactivateMachine(machineId) {
    return this.client.deactivateMachine(machineId);
  }

  /**
   * Synchronize local PostgreSQL license state with Keygen CE
   * @param {string} accountId 
   */
  async syncLicenseState(accountId) {
    const pool = getPool();
    const licenseRes = await pool.query(
      "SELECT * FROM licenses WHERE account_id = $1 AND status = 'VALID' ORDER BY issued_at DESC LIMIT 1",
      [accountId]
    );
    if (licenseRes.rows.length === 0) return;
    const license = licenseRes.rows[0];

    // Check with Keygen
    const remote = await this.validateLicense(license.license_id);
    if (!remote.valid && license.status === 'VALID') {
      await pool.query(
        "UPDATE licenses SET status = 'EXPIRED', updated_at = now() WHERE license_id = $1",
        [license.license_id]
      );
    }
  }
}

export const keygenAdapter = new KeygenAdapter();
