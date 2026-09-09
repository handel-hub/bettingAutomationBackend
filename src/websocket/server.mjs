// @ts-check
import { WebSocketServer, WebSocket } from 'ws';

import { getPool } from '../persistence/connection.mjs';

/** @type {WebSocketServer | null} */
let wssInstance = null;

/**
 * Initialize the WebSocket Server on the provided HTTP server.
 * Mounts strictly on path /ws/v1/events.
 * @param {import('http').Server} httpServer 
 * @returns {WebSocketServer}
 */
export function initWebSocketServer(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/v1/events'
  });

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

      // Send initial handshake envelope
      ws.send(JSON.stringify({
        topic: 'app:state',
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
 * Broadcast an event envelope to connected WebSocket clients, isolated by targetAccountId if specified.
 * @param {string} topic 
 * @param {any} payload 
 * @param {string | null} [targetAccountId=null]
 */
export function broadcast(topic, payload, targetAccountId = null) {
  if (!wssInstance) return;

  const message = JSON.stringify({
    topic,
    timestamp: new Date().toISOString(),
    payload
  });

  for (const client of wssInstance.clients) {
    if (client.readyState === WebSocket.OPEN) {
      // @ts-ignore
      if (targetAccountId && client.accountId && client.accountId !== targetAccountId) {
        continue;
      }
      client.send(message);
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

