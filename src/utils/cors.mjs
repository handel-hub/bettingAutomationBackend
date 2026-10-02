// @ts-check

/**
 * Validates whether an incoming HTTP or WebSocket Origin header is permitted.
 * Non-browser requests without an Origin header are always permitted.
 * In development/test mode, localhost, 127.0.0.1, and private LAN IPs are permitted.
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
