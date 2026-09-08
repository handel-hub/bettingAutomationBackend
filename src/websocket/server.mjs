// @ts-check
import { WebSocketServer, WebSocket } from 'ws';

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

  wss.on('connection', (ws, req) => {
    // Send initial handshake envelope
    ws.send(JSON.stringify({
      topic: 'app:state',
      timestamp: new Date().toISOString(),
      payload: {
        state: 'Authorized',
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
  });

  wssInstance = wss;
  console.log('✓ WebSocket Server mounted on /ws/v1/events');
  return wss;
}

/**
 * Broadcast an event envelope to all connected WebSocket clients.
 * @param {string} topic 
 * @param {any} payload 
 */
export function broadcast(topic, payload) {
  if (!wssInstance) return;

  const message = JSON.stringify({
    topic,
    timestamp: new Date().toISOString(),
    payload
  });

  for (const client of wssInstance.clients) {
    if (client.readyState === WebSocket.OPEN) {
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
