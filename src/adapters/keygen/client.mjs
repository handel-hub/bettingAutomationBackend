// @ts-check
import { performance } from 'node:perf_hooks';
import { rootLogger } from '../../utils/Logger.mjs';
import { metrics } from '../../utils/metrics.mjs';

const keygenLogger = rootLogger.child({ component: 'KeygenAdapter' });

/**
 * HTTP Client for Keygen CE API
 */
export class KeygenClient {
  /**
   * @param {Object} [config]
   * @param {string} [config.baseUrl]
   * @param {string} [config.accountToken]
   * @param {string} [config.accountId]
   */
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || process.env.KEYGEN_BASE_URL || 'http://localhost:4000/v1';
    this.accountToken = config.accountToken || process.env.KEYGEN_PRODUCT_TOKEN || '';
    this.accountId = config.accountId || process.env.KEYGEN_ACCOUNT_ID || '';
  }

  /**
   * @param {string} endpoint 
   * @param {Object} [options] 
   * @returns {Promise<any>}
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json',
      ...(this.accountToken ? { 'Authorization': `Bearer ${this.accountToken}` } : {}),
      ...(options.headers || {})
    };

    // If in stub/test mode or keygen URL unreachable, provide stub response
    if (process.env.NODE_ENV === 'test' || !this.accountToken) {
      return { data: { id: 'mock-keygen-id', attributes: { status: 'ACTIVE' } } };
    }

    const start = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers
      });
      clearTimeout(timeoutId);
      const elapsed = performance.now() - start;

      metrics.recordExternalCall('keygen', endpoint, res.status, elapsed);
      keygenLogger.info({
        event: 'external_call_completed',
        provider: 'keygen',
        endpoint,
        statusCode: res.status,
        durationMs: Math.round(elapsed * 100) / 100
      }, `Keygen CE API HTTP ${res.status} (${elapsed.toFixed(1)}ms): ${endpoint}`);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Keygen API error HTTP_${res.status}: ${text}`);
      }
      return res.json();
    } catch (err) {
      clearTimeout(timeoutId);
      const elapsed = performance.now() - start;
      const isTimeout = err.name === 'AbortError';

      metrics.recordExternalFailure('keygen', endpoint, isTimeout ? 'TIMEOUT' : 'ERROR');
      keygenLogger.error({
        event: 'external_call_failed',
        provider: 'keygen',
        endpoint,
        isTimeout,
        durationMs: Math.round(elapsed * 100) / 100,
        errMessage: err.message
      }, `Keygen CE API call failed (${isTimeout ? 'TIMEOUT' : err.message})`);

      if (process.env.NODE_ENV !== 'production' && !process.env.KEYGEN_BASE_URL) {
        return { data: { id: 'stub-id', attributes: { status: 'ACTIVE' } } };
      }
      throw err;
    }
  }

  /**
   * Validate license key
   * @param {string} licenseKey 
   */
  async validateKey(licenseKey) {
    return this.request(`/licenses/actions/validate-key`, {
      method: 'POST',
      body: JSON.stringify({
        meta: { key: licenseKey }
      })
    });
  }

  /**
   * Activate a machine under a license
   * @param {string} licenseId 
   * @param {string} fingerprint 
   */
  async activateMachine(licenseId, fingerprint) {
    return this.request(`/machines`, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'machines',
          attributes: { fingerprint },
          relationships: {
            license: { data: { type: 'licenses', id: licenseId } }
          }
        }
      })
    });
  }

  /**
   * Deactivate a machine under a license
   * @param {string} machineId 
   */
  async deactivateMachine(machineId) {
    return this.request(`/machines/${machineId}`, {
      method: 'DELETE'
    });
  }
}

export const keygenClient = new KeygenClient();
