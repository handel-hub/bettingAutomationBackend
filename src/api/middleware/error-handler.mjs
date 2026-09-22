// @ts-check
import { buildEnvelope } from '../../protocol/envelope.mjs';

/**
 * Standardized Machine-Readable Error Taxonomy Registry
 */
const ERROR_TAXONOMY = {
  // Authentication & Replay
  NONCE_EXPIRED: {
    status: 400,
    code: 'BE_AUTH_NONCE_EXPIRED',
    legacyCode: 'NONCE_EXPIRED',
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Request timestamp expired or out of bounds (±30s drift)'
  },
  NONCE_REPLAYED: {
    status: 409,
    code: 'BE_AUTH_NONCE_REPLAYED',
    legacyCode: 'NONCE_REPLAYED',
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Nonce has already been consumed'
  },
  INVALID_SIGNATURE: {
    status: 401,
    code: 'BE_AUTH_INVALID_SIGNATURE',
    legacyCode: 'INVALID_SIGNATURE',
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Cryptographic signature verification failed'
  },
  INVALID_CREDENTIALS: {
    status: 401,
    code: 'BE_AUTH_INVALID_CREDENTIALS',
    legacyCode: 'INVALID_CREDENTIALS',
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Invalid email or password'
  },
  AUTH_FAILED: {
    status: 401,
    code: 'BE_AUTH_INVALID_CREDENTIALS',
    legacyCode: 'AUTH_FAILED',
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Invalid email or password'
  },
  SESSION_EXPIRED: {
    status: 401,
    code: 'BE_AUTH_SESSION_EXPIRED',
    legacyCode: 'SESSION_EXPIRED',
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Session has expired; re-authentication required'
  },
  SESSION_REVOKED: {
    status: 403,
    code: 'BE_AUTH_SESSION_REVOKED',
    legacyCode: 'SESSION_REVOKED',
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Session or authorization lease has been revoked'
  },
  MACHINE_NOT_FOUND: {
    status: 403,
    code: 'BE_AUTH_MACHINE_NOT_FOUND',
    legacyCode: 'MACHINE_NOT_FOUND',
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Machine identity not registered'
  },
  MACHINE_REVOKED: {
    status: 403,
    code: 'BE_AUTH_MACHINE_REVOKED',
    legacyCode: 'MACHINE_REVOKED',
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Machine has been revoked by security policy'
  },
  ACCOUNT_LOCKED: {
    status: 423,
    code: 'BE_AUTH_ACCOUNT_LOCKED',
    legacyCode: 'ACCOUNT_LOCKED',
    category: 'AUTHENTICATION',
    retryable: false,
    message: 'Account is locked due to security policy'
  },

  // Concurrency & Generation
  GENERATION_MISMATCH: {
    status: 409,
    code: 'BE_REV_GENERATION_MISMATCH',
    legacyCode: 'GENERATION_MISMATCH',
    category: 'CONCURRENCY',
    retryable: false,
    message: 'Client generation does not match authoritative state'
  },
  EPOCH_MISMATCH: {
    status: 409,
    code: 'BE_REV_EPOCH_MISMATCH',
    legacyCode: 'EPOCH_MISMATCH',
    category: 'CONCURRENCY',
    retryable: false,
    message: 'Server epoch mismatch; state re-synchronization required'
  },
  RESOURCE_LOCKED: {
    status: 423,
    code: 'BE_STATE_RESOURCE_LOCKED',
    legacyCode: 'RESOURCE_LOCKED',
    category: 'CONCURRENCY',
    retryable: true,
    message: 'Resource temporarily locked by concurrent operation'
  },

  // Licensing & Permissions
  ENTITLEMENT_EXCEEDED: {
    status: 403,
    code: 'BE_PERM_ENTITLEMENT_EXCEEDED',
    legacyCode: 'ENTITLEMENT_EXCEEDED',
    category: 'LICENSING',
    retryable: false,
    message: 'Operation exceeds subscription entitlement bounds'
  },
  LICENSE_EXPIRED: {
    status: 403,
    code: 'BE_PERM_LICENSE_EXPIRED',
    legacyCode: 'LICENSE_EXPIRED',
    category: 'LICENSING',
    retryable: false,
    message: 'Active license required for this operation'
  },
  REQUIRES_STEP_UP: {
    status: 403,
    code: 'BE_PERM_STEP_UP_REQUIRED',
    legacyCode: 'REQUIRES_STEP_UP',
    category: 'SECURITY',
    retryable: false,
    message: 'Step-up challenge required for this operation'
  },

  // Validation & Conflict
  INVALID_FORMAT: {
    status: 400,
    code: 'BE_VAL_SCHEMA_VIOLATION',
    legacyCode: 'INVALID_FORMAT',
    category: 'VALIDATION',
    retryable: false,
    message: 'Payload format violates boundary contract schema'
  },
  ACCOUNT_EXISTS: {
    status: 409,
    code: 'BE_STATE_ACCOUNT_EXISTS',
    legacyCode: 'ACCOUNT_EXISTS',
    category: 'CONFLICT',
    retryable: false,
    message: 'Account with this platform and username already exists'
  },

  // System & Availability
  RATE_LIMIT_EXCEEDED: {
    status: 429,
    code: 'BE_RATE_LIMIT_EXCEEDED',
    legacyCode: 'RATE_LIMIT_EXCEEDED',
    category: 'RATE_LIMIT',
    retryable: true,
    message: 'Rate limit exceeded'
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    code: 'BE_SYS_SERVICE_UNAVAILABLE',
    legacyCode: 'SERVICE_UNAVAILABLE',
    category: 'SYSTEM',
    retryable: true,
    message: 'Service or security gateway temporarily unavailable'
  }
};

/**
 * Global error handler middleware that emits standard BE_* error taxonomy
 * and wraps responses in signed envelopes when handling envelope requests.
 * 
 * @param {Error & { status?: number; code?: string }} err 
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 * @param {import('express').NextFunction} next 
 */
export async function errorHandler(err, req, res, next) {
  const errText = `${err.message || ''} ${err.code || ''}`;
  let matched = null;

  for (const [key, mapping] of Object.entries(ERROR_TAXONOMY)) {
    if (err.code === key || err.code === mapping.code || errText.includes(key)) {
      matched = mapping;
      break;
    }
  }

  let statusCode = err.status || (matched ? matched.status : 500);
  let code = matched ? matched.code : (err.code || 'BE_SYS_INTERNAL_ERROR');
  let legacyCode = matched ? matched.legacyCode : (err.code || 'INTERNAL_ERROR');
  let category = matched ? matched.category : 'SYSTEM';
  let retryable = matched ? matched.retryable : false;
  let message = err.message || (matched ? matched.message : 'An internal error occurred');

  if (!matched) {
    if (errText.includes('UNAUTHORIZED') || statusCode === 401) {
      statusCode = 401;
      code = 'BE_AUTH_UNAUTHORIZED';
      legacyCode = 'UNAUTHORIZED';
      category = 'AUTHENTICATION';
    } else if (errText.includes('CLONE_SUSPECTED')) {
      statusCode = 403;
      code = 'BE_AUTH_CLONE_SUSPECTED';
      legacyCode = 'CLONE_SUSPECTED';
      category = 'AUTHENTICATION';
    }
  }

  // Only dump full stack traces for unexpected internal 500 errors.
  // 4xx operational errors (e.g. invalid credentials, expired session) should not pollute the console with error traces.
  if (statusCode >= 500) {
    console.error(err);
  }

  res.status(statusCode);

  const errorObj = {
    code,
    legacyCode,
    message,
    category,
    retryable,
    timestamp: new Date().toISOString(),
    requestId: req.headers['x-request-id'] || req.headers['x-trace-id'] || req.envelope?.nonce || undefined
  };

  // If request was a signed Protocol Envelope, return signed envelope with error
  if (req.envelope || (req.body && req.body.version === 2)) {
    try {
      const signedError = await buildEnvelope({ error: errorObj }, 0);
      return res.json({
        ...signedError,
        error: errorObj
      });
    } catch (signErr) {
      console.error('Failed to sign error response (KMS down?)', signErr);
      return res.status(503).json({
        error: {
          code: 'BE_SYS_SERVICE_UNAVAILABLE',
          legacyCode: 'SERVICE_UNAVAILABLE',
          message: 'Security gateway unavailable',
          category: 'SYSTEM',
          retryable: true,
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  // Otherwise return standard JSON error
  return res.json({
    error: errorObj
  });
}
