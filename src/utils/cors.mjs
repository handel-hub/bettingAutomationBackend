// @ts-check
import os from 'node:os';

/**
 * Dynamically resolves all active IPv4 addresses bound to the host system's network interfaces.
 * @returns {Set<string>}
 */
export function resolveSystemIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = new Set(['127.0.0.1']);

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      const family = typeof iface.family === 'string' ? iface.family : String(iface.family);
      if ((family === 'IPv4' || family === '4') && iface.address) {
        addresses.add(iface.address);
      }
    }
  }

  return addresses;
}

/**
 * Validates whether an incoming HTTP or WebSocket Origin header is permitted.
 * Non-browser requests without an Origin header are always permitted.
 * In development/test mode, localhost, 127.0.0.1, dynamically resolved system IPv4 addresses, and private LAN IPs are permitted.
 * In all environments, origins matching CORS_ALLOWED_ORIGINS (or official console defaults) are permitted.
 * 
 * @param {string | undefined | null} origin
 * @returns {boolean}
 */
export function isOriginAllowed(origin) {
  // Non-browser server-to-server requests (like ACP, curl, mobile native) don't have an Origin header
  if (!origin) {
    return true;
  }

  const lowerOrigin = origin.toLowerCase().trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    // Check dynamically resolved system IPv4 interfaces
    try {
      const parsed = new URL(lowerOrigin);
      if (resolveSystemIPv4Addresses().has(parsed.hostname)) {
        return true;
      }
    } catch {
      // Ignore malformed URLs and fall through to standard checks
    }

    // In dev/test, permit local loopback & private networks
    if (
      lowerOrigin.startsWith('http://localhost:') ||
      lowerOrigin.startsWith('http://127.0.0.1:') ||
      lowerOrigin.startsWith('http://[::1]:') ||
      lowerOrigin === 'http://localhost' ||
      lowerOrigin === 'http://127.0.0.1' ||
      /^http:\/\/(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(lowerOrigin)
    ) {
      return true;
    }
  }

  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(s => s.trim().toLowerCase())
    : ['https://console.bettingautomation.io', 'https://app.bettingautomation.io'];

  return allowedOrigins.includes(lowerOrigin);
}
