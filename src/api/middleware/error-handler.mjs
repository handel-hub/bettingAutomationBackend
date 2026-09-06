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
  
  const statusCode = err.status || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'An internal error occurred';
  
  if (err.message === 'NONCE_REPLAYED') {
    res.status(403);
    code = 'NONCE_REPLAYED';
  } else if (err.message === 'ACCOUNT_LOCKED') {
    res.status(423);
    code = 'ACCOUNT_LOCKED';
  }
  
  // Wrap in signed envelope
  try {
    const errorPayload = {
      error: {
        code,
        message
      }
    };
    
    // Some responses need specific guard fields if they are an error for a specific operation
    // e.g. SESSION_REVOKED might need responseValidated etc. But usually errors just carry the error object.
    
    const signedError = await buildEnvelope(errorPayload, { session: 0, machine: 0 }); // dummy generation for error
    res.json(signedError);
  } catch (signErr) {
    // If KMS is down, we cannot sign. Fallback to unsigned 503.
    console.error('Failed to sign error response (KMS down?)', signErr);
    res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Security gateway unavailable'
      }
    });
  }
}
