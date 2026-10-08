import { Request, Response, NextFunction } from 'express';

const requestCounts: Record<string, { count: number; resetTime: number }> = {};

const TIER_LIMITS: Record<string, number> = {
  free: 20,
  premium: 100,
};

const WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Paths that should NOT count toward rate limit
const SKIP_PATHS = [
  '/health',
  '/transcribe/',  // GET status/result/srt/vtt polls
  '/queue/stats',
  '/auth/keys',
  '/cache/stats',
];

function shouldSkip(req: Request): boolean {
  // Count all transcription submissions, including uploads.
  if (req.method === 'POST' && (req.path === '/transcribe' || req.path === '/transcribe/upload')) {
    return false; // COUNT IT
  }
  
  // Skip everything else: GET, DELETE, PUT, POST to other paths
  return true;
}

export function rateLimiter(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.user?.apiKey;
  const tier = req.user?.tier || 'free';
  const limit = TIER_LIMITS[tier] || 20;

  if (!apiKey) return next();

  // Skip rate limiting for non-submission requests
  if (shouldSkip(req)) {
    return next();
  }

  const now = Date.now();
  const userRequests = requestCounts[apiKey];

  if (!userRequests || now > userRequests.resetTime) {
    requestCounts[apiKey] = { count: 1, resetTime: now + WINDOW_MS };
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', limit - 1);
    console.log(`📊 Rate: ${apiKey.slice(-8)} - 1/${limit}`);
    return next();
  }

  if (userRequests.count >= limit) {
    const retryAfter = Math.ceil((userRequests.resetTime - now) / 1000);
    console.log(`🚫 Rate EXCEEDED: ${apiKey.slice(-8)} - ${userRequests.count}/${limit}`);
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: `You've used ${userRequests.count}/${limit} job submissions this hour`,
      retryAfter: `${retryAfter} seconds`,
      tier: tier,
      limit: limit,
      remaining: 0
    });
  }

  userRequests.count++;
  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', limit - userRequests.count);
  console.log(`📊 Rate: ${apiKey.slice(-8)} - ${userRequests.count}/${limit}`);
  next();
}
