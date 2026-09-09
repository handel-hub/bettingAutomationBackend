// @ts-check
import { buildEnvelope } from '../../protocol/envelope.mjs';

/**
 * Global error handler middleware that wraps errors in a signed envelope.
 * @param {Error} err 
 * @param {import('express').Request} req 
 * @param {import('express').Response} res 
 * @param {import('express').NextFunction} next 
 */
export async function errorHandler(err, req, res, next) {
  console.error(err);
  
  let statusCode = err.status || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'An internal error occurred';
  
  // Standardize error code mapping for protocol and CP interoperability
  const errText = (err.message || '') + ' ' + (err.code || '');
  if (errText.includes('NONCE_REPLAYED') || errText.includes('DUPLICATE_NONCE')) {
    statusCode = 403;
    code = 'NONCE_REPLAYED';
    message = 'Nonce has already been used';
  } else if (errText.includes('NONCE_EXPIRED') || errText.includes('Timestamp expired')) {
    statusCode = 401;
    code = 'NONCE_EXPIRED';
    message = 'Request timestamp expired or out of bounds';
  } else if (errText.includes('INVALID_SIGNATURE') || errText.includes('Invalid signature')) {
    statusCode = 403;
    code = 'INVALID_SIGNATURE';
    message = 'Signature verification failed';
  } else if (errText.includes('ACCOUNT_LOCKED')) {
    statusCode = 423;
    code = 'ACCOUNT_LOCKED';
    message = 'Account is locked due to security policy or excessive failed logins';
  } else if (errText.includes('AUTH_FAILED') || errText.includes('INVALID_CREDENTIALS')) {
    statusCode = 401;
    code = 'INVALID_CREDENTIALS';
    message = 'Invalid email or password';
  } else if (errText.includes('GENERATION_MISMATCH')) {
    statusCode = 403;
    code = 'GENERATION_MISMATCH';
    message = 'Client generation does not match authoritative state';
  } else if (errText.includes('MACHINE_REVOKED') || errText.includes('revoked')) {
    statusCode = 403;
    code = 'MACHINE_REVOKED';
    message = 'Machine or session has been revoked';
  } else if (errText.includes('UNAUTHORIZED') || statusCode === 401) {
    statusCode = 401;
    code = 'UNAUTHORIZED';
  } else if (errText.includes('CLONE_SUSPECTED')) {
    statusCode = 403;
    code = 'CLONE_SUSPECTED';
  }

  res.status(statusCode);

  const errorObj = {
    code,
    message
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
          code: 'SERVICE_UNAVAILABLE',
          message: 'Security gateway unavailable'
        }
      });
    }
  }

  // Otherwise return standard JSON error
  return res.json({
    error: errorObj
  });
}
