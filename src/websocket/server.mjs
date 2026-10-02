// @ts-check
import { WebSocketServer, WebSocket } from 'ws';

import { getPool } from '../persistence/connection.mjs';
import { getSystemEpoch } from '../domain/system/epoch-store.mjs';
import { isOriginAllowed } from '../utils/cors.mjs';
import crypto from 'crypto';

/** @type {WebSocketServer | null} */
let wssInstance = null;

/**
 * Per-account monotonic sequence number map for gap detection.
 * @type {Map<string, number>}
 */
const accountSequences = new Map();

/**
 * Get current sequence number for an account.
 * @param {string} accountId 
 * @returns {number}
 */
export function getAccountSequence(accountId) {
  return accountSequences.get(accountId) || 0;
}

/**
 * Initialize the WebSocket Server on the provided HTTP server.
 * Mounts strictly on path /ws/v1/events with CSWSH Origin validation.
 * @param {import('http').Server} httpServer 
 * @returns {WebSocketServer}
 */
export function initWebSocketServer(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/v1/events',
    verifyClient: (info, callback) => {
      const origin = info.origin || info.req.headers.origin;
      if (isOriginAllowed(origin)) {
        return callback(true);
      }
      return callback(false, 403, 'Forbidden: Origin Not Allowed');
    }
  });
  wssInstance = wss;

  wss.on('connection', async (ws, req) => {
    try {
      // Extract authentication token from query string or protocol/header
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      const token = url.searchParams.get('token') || 
                    url.searchParams.get('session') ||
                    url.searchParams.get('sessionId') || 
                    req.headers['x-session-id'] || 
                    (req.headers['sec-websocket-protocol'] ? req.headers['sec-websocket-protocol'].split(',')[0].trim() : null);

      if (!token) {
        ws.close(1008, 'UNAUTHORIZED: Authentication token required');
        return;
      }

      const pool = getPool();
      let authenticatedAccountId = null;
      let authenticatedSessionId = null;

      const sessRes = await pool.query(`
        SELECT s.session_id, s.account_id, s.status, s.expires_at, a.status as account_status
        FROM sessions s
        JOIN accounts a ON s.account_id = a.account_id
        WHERE s.session_id = $1 AND s.status = 'AUTHENTICATED' AND s.expires_at > now()
      `, [token]);

      if (sessRes.rows.length === 0 || sessRes.rows[0].account_status === 'LOCKED') {
        ws.close(1008, 'UNAUTHORIZED: Invalid or expired session');
        return;
      }

      authenticatedAccountId = sessRes.rows[0].account_id;
      authenticatedSessionId = sessRes.rows[0].session_id;

      // @ts-ignore
      ws.accountId = authenticatedAccountId;
      // @ts-ignore
      ws.sessionId = authenticatedSessionId;

      console.log(`✓ [WebSocket] Client connected: session ${authenticatedSessionId} (Account: ${authenticatedAccountId})`);

      const currentSeq = getAccountSequence(authenticatedAccountId);

      // Send initial handshake envelope matching Server-to-ACP Event specification
      ws.send(JSON.stringify({
        eventId: `evt_init_${crypto.randomUUID()}`,
        eventType: 'app:state',
        topic: 'app:state',
        sequenceNumber: currentSeq,
        server_epoch: getSystemEpoch(),
        timestamp: new Date().toISOString(),
        payload: {
          state: 'Authorized',
          accountId: authenticatedAccountId,
          message: 'Connected to Betting Automation Control Plane & Cloud Stream'
        }
      }));

      ws.on('message', (message) => {
        try {
          const parsed = JSON.parse(message.toString());
          if (parsed.type === 'PING') {
            ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
          }
        } catch {
          // ignore malformed ping/frames
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`ℹ [WebSocket] Client disconnected: session ${authenticatedSessionId}`);
      });

      ws.on('error', (err) => {
        console.error('WebSocket client error:', err);
      });
    } catch (err) {
      console.error('Error during WebSocket connection setup:', err);
      ws.close(1011, 'Internal Server Error');
    }
  });

  wssInstance = wss;
  console.log('✓ WebSocket Server mounted on /ws/v1/events');
  return wss;
}

/**
 * Emits a structured Server-to-ACP event envelope with monotonic per-account sequence number.
 * @param {string} accountId
 * @param {string} eventType
 * @param {any} payload
 * @returns {Object} The transmitted event envelope
 */
export function emitServerEvent(accountId, eventType, payload) {
  const nextSeq = (accountSequences.get(accountId) || 0) + 1;
  accountSequences.set(accountId, nextSeq);

  const eventEnvelope = {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType,
    topic: eventType, // Backward-compatibility bridge
    sequenceNumber: nextSeq,
    server_epoch: getSystemEpoch(),
    timestamp: new Date().toISOString(),
    payload
  };

  if (!wssInstance) return eventEnvelope;

  const rawMessage = JSON.stringify(eventEnvelope);
  for (const client of wssInstance.clients) {
    if (client.readyState === WebSocket.OPEN) {
      // Strictly check client.accountId to prevent leakage to unauthenticated pending sockets
      // @ts-ignore
      if (client.accountId && client.accountId === accountId) {
        client.send(rawMessage);
      }
    }
  }

  return eventEnvelope;
}

/**
 * Broadcast an event envelope to connected WebSocket clients, isolated by targetAccountId if specified.
 * Adapts legacy calls into the structured Server-to-ACP event stream.
 * @param {string} topic 
 * @param {any} payload 
 * @param {string | null} [targetAccountId=null]
 */
export function broadcast(topic, payload, targetAccountId = null) {
  if (targetAccountId) {
    return emitServerEvent(targetAccountId, topic, payload);
  }

  if (!wssInstance) return;

  const globalEnvelope = {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: topic,
    topic,
    server_epoch: getSystemEpoch(),
    timestamp: new Date().toISOString(),
    payload
  };

  const rawMessage = JSON.stringify(globalEnvelope);
  for (const client of wssInstance.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(rawMessage);
    }
  }
}

/**
 * Get current connected client count
 * @returns {number}
 */
export function getConnectedClientCount() {
  return wssInstance ? wssInstance.clients.size : 0;
}

/**
 * Terminate all connected clients and close the WebSocket server instance.
 */
export function closeWebSocketServer() {
  if (wssInstance) {
    for (const client of wssInstance.clients) {
      try {
        client.terminate();
      } catch { /* ignore */ }
    }
    try {
      wssInstance.close();
    } catch { /* ignore */ }
    wssInstance = null;
  }
}

