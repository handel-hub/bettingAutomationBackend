// @ts-check
import rateLimit from 'express-rate-limit';

export const ipRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many requests from this IP, please try again after 15 minutes'
    }
  }
});

// Since we cannot easily rate limit by account before they authenticate in standard middleware,
// we typically apply a stricter limit to the auth endpoint itself.
export const authAccountRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs for auth (rough proxy for account if no email given)
  keyGenerator: (req) => req.body.email || req.ip,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many authentication attempts, please try again after 15 minutes'
    }
  }
});
