// @ts-check

/**
 * In-memory bounded metrics registry for application telemetry.
 * Restricts dimensions to safe bounded cardinality sets.
 */
class MetricsRegistry {
  constructor() {
    /** @type {Map<string, number>} */
    this.httpRequests = new Map();
    /** @type {Map<string, { count: number, totalMs: number }>} */
    this.httpDuration = new Map();
    /** @type {Map<string, { count: number, totalMs: number }>} */
    this.dbQueries = new Map();
    /** @type {Map<string, number>} */
    this.dbErrors = new Map();
    /** @type {Map<string, { count: number, totalMs: number }>} */
    this.dbTransactions = new Map();
    /** @type {Map<string, { count: number, totalMs: number }>} */
    this.externalCalls = new Map();
    /** @type {Map<string, number>} */
    this.externalErrors = new Map();
    /** @type {Map<string, { count: number, totalMs: number, failures: number }>} */
    this.outboxEvents = new Map();
    /** @type {Map<string, { count: number, totalMs: number, failures: number }>} */
    this.scheduledJobs = new Map();
    /** @type {number} */
    this.activeWsConnections = 0;
  }

  /**
   * @param {string} method 
   * @param {string} route 
   * @param {number} status 
   * @param {number} durationMs 
   */
  recordHttpRequest(method, route, status, durationMs) {
    const statusKey = `${method} ${route} ${status}`;
    this.httpRequests.set(statusKey, (this.httpRequests.get(statusKey) || 0) + 1);

    const durKey = `${method} ${route}`;
    const cur = this.httpDuration.get(durKey) || { count: 0, totalMs: 0 };
    cur.count++;
    cur.totalMs += durationMs;
    this.httpDuration.set(durKey, cur);
  }

  /**
   * @param {string} normalizedSql 
   * @param {number} durationMs 
   */
  recordDbQuery(normalizedSql, durationMs) {
    const key = normalizedSql.slice(0, 80);
    const cur = this.dbQueries.get(key) || { count: 0, totalMs: 0 };
    cur.count++;
    cur.totalMs += durationMs;
    this.dbQueries.set(key, cur);
  }

  /**
   * @param {string} normalizedSql 
   * @param {string} errCode 
   */
  recordDbError(normalizedSql, errCode) {
    const key = `${normalizedSql.slice(0, 40)} [${errCode}]`;
    this.dbErrors.set(key, (this.dbErrors.get(key) || 0) + 1);
  }

  /**
   * @param {string} isolationLevel 
   * @param {number} durationMs 
   */
  recordTransaction(isolationLevel, durationMs) {
    const cur = this.dbTransactions.get(isolationLevel) || { count: 0, totalMs: 0 };
    cur.count++;
    cur.totalMs += durationMs;
    this.dbTransactions.set(isolationLevel, cur);
  }

  /**
   * @param {string} provider 
   * @param {string} endpoint 
   * @param {number} status 
   * @param {number} durationMs 
   */
  recordExternalCall(provider, endpoint, status, durationMs) {
    const key = `${provider} ${endpoint} ${status}`;
    const cur = this.externalCalls.get(key) || { count: 0, totalMs: 0 };
    cur.count++;
    cur.totalMs += durationMs;
    this.externalCalls.set(key, cur);
  }

  /**
   * @param {string} provider 
   * @param {string} endpoint 
   * @param {string} errType 
   */
  recordExternalFailure(provider, endpoint, errType) {
    const key = `${provider} ${endpoint} ${errType}`;
    this.externalErrors.set(key, (this.externalErrors.get(key) || 0) + 1);
  }

  /**
   * @param {string} eventType 
   * @param {number} durationMs 
   * @param {boolean} success 
   */
  recordOutboxEvent(eventType, durationMs, success) {
    const cur = this.outboxEvents.get(eventType) || { count: 0, totalMs: 0, failures: 0 };
    cur.count++;
    cur.totalMs += durationMs;
    if (!success) cur.failures++;
    this.outboxEvents.set(eventType, cur);
  }

  /**
   * @param {string} jobName 
   * @param {number} durationMs 
   * @param {boolean} success 
   */
  recordJobRun(jobName, durationMs, success) {
    const cur = this.scheduledJobs.get(jobName) || { count: 0, totalMs: 0, failures: 0 };
    cur.count++;
    cur.totalMs += durationMs;
    if (!success) cur.failures++;
    this.scheduledJobs.set(jobName, cur);
  }

  /**
   * @param {number} delta 
   */
  recordWsConnection(delta) {
    this.activeWsConnections = Math.max(0, this.activeWsConnections + delta);
  }

  /**
   * Get telemetry JSON snapshot
   */
  getSnapshot() {
    return {
      timestamp: new Date().toISOString(),
      activeWsConnections: this.activeWsConnections,
      httpRequests: Object.fromEntries(this.httpRequests),
      httpAverageLatenciesMs: Object.fromEntries(
        Array.from(this.httpDuration.entries()).map(([k, v]) => [k, Math.round(v.totalMs / v.count * 100) / 100])
      ),
      dbQueries: Object.fromEntries(
        Array.from(this.dbQueries.entries()).map(([k, v]) => [k, { count: v.count, avgMs: Math.round(v.totalMs / v.count * 100) / 100 }])
      ),
      dbErrors: Object.fromEntries(this.dbErrors),
      dbTransactions: Object.fromEntries(
        Array.from(this.dbTransactions.entries()).map(([k, v]) => [k, { count: v.count, avgMs: Math.round(v.totalMs / v.count * 100) / 100 }])
      ),
      externalCalls: Object.fromEntries(
        Array.from(this.externalCalls.entries()).map(([k, v]) => [k, { count: v.count, avgMs: Math.round(v.totalMs / v.count * 100) / 100 }])
      ),
      externalErrors: Object.fromEntries(this.externalErrors),
      outboxEvents: Object.fromEntries(this.outboxEvents),
      scheduledJobs: Object.fromEntries(this.scheduledJobs)
    };
  }

  /**
   * Export in standard Prometheus text format
   */
  getPrometheusFormat() {
    const lines = [];
    lines.push('# HELP http_requests_total Total number of HTTP requests');
    lines.push('# TYPE http_requests_total counter');
    for (const [key, count] of this.httpRequests.entries()) {
      const [method, route, status] = key.split(' ');
      lines.push(`http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`);
    }

    lines.push('# HELP active_websocket_connections Current active WebSocket connections');
    lines.push('# TYPE active_websocket_connections gauge');
    lines.push(`active_websocket_connections ${this.activeWsConnections}`);

    return lines.join('\n') + '\n';
  }
}

export const metrics = new MetricsRegistry();
