import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { transcriptionRoutes } from './routes/transcription';
import { authRoutes } from './routes/auth';
import { apiKeyMiddleware } from './middleware/apiKey';
import { rateLimiter } from './middleware/rateLimit';

dotenv.config();

import './db/init';

const app = express();
const PORT = process.env.GATEWAY_PORT || 3001;

// app.use(helmet());
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors());
app.use(express.json());

// Health check rate limiter
const healthChecks: Record<string, { count: number; resetTime: number }> = {};
const HEALTH_LIMIT = 30;
const HEALTH_WINDOW = 60 * 1000;

function healthRateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = healthChecks[ip];
  if (!record || now > record.resetTime) {
    healthChecks[ip] = { count: 1, resetTime: now + HEALTH_WINDOW };
    return next();
  }
  if (record.count >= HEALTH_LIMIT) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  record.count++;
  next();
}

// Public
app.get('/health', healthRateLimiter, (_req: Request, res: Response) => {
  res.json({ service: 'Video Transcription API Gateway', version: '1.0.0', status: 'healthy' });
});

// Auth routes (public - no API key needed for register/login/verify/reset)
app.use('/api/v1', authRoutes);

// Protected routes (API key required)
app.use('/api/v1', apiKeyMiddleware, rateLimiter, transcriptionRoutes);

app.use((_req: Request, res: Response) => res.status(404).json({ error: 'Not found' }));
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 API Gateway running on http://localhost:${PORT}`);
  console.log(`📡 Python service: ${process.env.PYTHON_SERVICE_URL}`);
  console.log(`🗄️  Database: SQLite (WAL mode)`);
});
