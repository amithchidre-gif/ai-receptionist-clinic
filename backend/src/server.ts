import dotenv from 'dotenv';
dotenv.config();

console.log(`[server.ts] process.cwd(): ${process.cwd()}`);

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config/env';
import { sendSuccess, sendError } from './middleware/responseHelpers';
import { errorHandler } from './middleware/errorHandler';

const app = express();
const PORT = config.port;

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(JSON.stringify({
      level: 'info',
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
      timestamp: new Date().toISOString(),
    }));
  });
  next();
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman) and any localhost origin
    if (!origin || /^http:\/\/localhost:\d+$/.test(origin)) {
      return callback(null, true);
    }
    if (origin === config.frontendUrl) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());

// Audio files are served via /api/audio/:id (see routes/audio.ts)

// Health check
app.get('/health', (req: Request, res: Response) => {
  sendSuccess(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Routes (placeholder imports)
// These will be implemented in later tasks
import authRoutes from './routes/auth';
import appointmentRoutes from './routes/appointments';
import patientRoutes from './routes/patients';
import callLogRoutes from './routes/call-logs';
import formRoutes, { handleFormTokenRequest } from './routes/forms';
import dashboardRoutes from './routes/dashboard';
import settingsRoutes from './routes/settings';
import voiceRoutes from './routes/voice';
import audioRoutes from './routes/audio';
import { handleTelnyxAudioStream } from './routes/wsStream';
import { startReminderScheduler } from './services/reminderScheduler';

app.use('/api/auth', authRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/call-logs', callLogRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/audio', audioRoutes);
app.use('/voice', voiceRoutes);

// ─── Debug endpoint (dev only) ────────────────────────────────────────────────
if (config.nodeEnv !== 'production') {
  app.get('/api/debug/config', async (req: Request, res: Response) => {
    const { pool } = await import('./config/db');
    let dbStatus = 'unknown';
    let dbError: string | null = null;
    try {
      await pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch (e) {
      dbStatus = 'failed';
      dbError = (e as Error).message;
    }
    const rawUrl = config.databaseUrl;
    const maskedUrl = rawUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
    res.json({
      cwd: process.cwd(),
      nodeEnv: config.nodeEnv,
      databaseUrl: maskedUrl,
      redisUrl: config.redisUrl,
      inworldKeySet: !!config.inworldApiKey,
      inworldKeyPrefix: config.inworldApiKey?.substring(0, 6) + '...',
      db: { status: dbStatus, error: dbError },
    });
  });
}

// Patient-facing form link: GET /form/:token  (no auth — patients click this from SMS)
app.get('/form/:token', handleFormTokenRequest);

// Error handler (must be last)
app.use(errorHandler);

// ─── HTTP + WebSocket server ─────────────────────────────────────────────────
// We need a raw http.Server so we can attach the WebSocket server for Telnyx
// audio streaming (wss://<BASE_URL>/voice/stream).
const httpServer = createServer(app);

// WebSocket server: only handles /voice/stream — all other WS upgrades are rejected.
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  try {
    const { pathname } = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (pathname === '/voice/stream') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleTelnyxAudioStream(ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

// Start server
httpServer.listen(PORT, () => {
  console.log(JSON.stringify({
    level: 'info',
    message: 'AI Receptionist backend running',
    port: PORT,
    environment: config.nodeEnv,
    timestamp: new Date().toISOString(),
  }));

  startReminderScheduler();
});
