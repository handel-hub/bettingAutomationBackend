// @ts-check
import rateLimit from 'express-rate-limit';

export const ipRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.IP_RATE_LIMIT_MAX || 30), // limit each IP per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    error: {
      code: 'BE_RATE_LIMIT_EXCEEDED',
      legacyCode: 'TOO_MANY_REQUESTS',
      message: 'Too many requests from this IP, please try again after 15 minutes'
    }
  }
});

// Rate limit authentication attempts per target email (supporting both Envelope V2 payload.email and flat body.email)
export const authAccountRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 5),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => {
    const rawEmail = req.body?.payload?.email || req.body?.email;
    if (typeof rawEmail === 'string' && rawEmail.trim()) {
      return rawEmail.trim().toLowerCase();
    }
    return req.ip || '127.0.0.1';
  },
  message: {
    error: {
      code: 'BE_RATE_LIMIT_EXCEEDED',
      legacyCode: 'TOO_MANY_REQUESTS',
      message: 'Too many authentication attempts, please try again after 15 minutes'
    }
  }
});
