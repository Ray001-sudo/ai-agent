'use strict';
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const { createServer } = require('http');
const { Server }       = require('socket.io');
const mongoose         = require('mongoose');

const { logger }          = require('./utils/logger');
const { initializeRedis } = require('./utils/redis');
const { initializeQueues }= require('./services/queueService');
const { AgentOrchestrator } = require('../agent/orchestrator');
const { globalLimiter }   = require('./middleware/rateLimiter');

const {
  authRoutes, tenderRoutes, companyRoutes, proposalRoutes,
  alertRoutes, analyticsRoutes, paymentRoutes, calendarRoutes,
  intelligenceRoutes, settingsRoutes, upgradeRoutes
} = require('./api/routes');

const adminRoutes  = require('./api/adminRoutes');

const app        = express();
const httpServer = createServer(app);

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin:      process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
  },
  pingTimeout:  60000,
  pingInterval: 25000
});

// ── Trust proxy (needed for Render/Heroku IP detection) ───────────────────────
app.set('trust proxy', 1);

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin:      process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,   // required for cookies
  methods:     ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Admin-Key']
}));

// ── Body / Cookie parsing ─────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Stripe webhook needs raw body BEFORE json parser ─────────────────────────
app.use('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }));

// ── Logging ───────────────────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: msg => logger.info(msg.trim()) },
  skip: (req) => req.path === '/health'
}));

// ── Global rate limiter ───────────────────────────────────────────────────────
app.use(globalLimiter);

// ── Store io on app so routes can emit ───────────────────────────────────────
app.set('io', io);

// ── Public routes ─────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/payments',      paymentRoutes);

// ── Authenticated routes ──────────────────────────────────────────────────────
app.use('/api/tenders',       tenderRoutes);
app.use('/api/company',       companyRoutes);
app.use('/api/settings',      settingsRoutes);
app.use('/api/alerts',        alertRoutes);
app.use('/api/proposals',     proposalRoutes);
app.use('/api/analytics',     analyticsRoutes);
app.use('/api/calendar',      calendarRoutes);
app.use('/api/intelligence',  intelligenceRoutes);
app.use('/api/upgrade',       upgradeRoutes);

// ── WhatsApp webhook ──────────────────────────────────────────────────────────
app.use('/api/whatsapp/webhook', require('./whatsapp/webhookHandler'));

// ── SECRET Admin routes ───────────────────────────────────────────────────────
// URL is not guessable — set ADMIN_PATH_SECRET in .env
// Example: ADMIN_PATH_SECRET=x7k2m9p4  →  /api/__x7k2m9p4/stats
const adminPath = process.env.ADMIN_PATH_SECRET
  ? `/api/__${process.env.ADMIN_PATH_SECRET}`
  : '/api/__admin_secret_change_me';

app.use(adminPath, adminRoutes);

// Do NOT log or expose the admin path
logger.info(`Admin panel mounted at secret path (configured in ADMIN_PATH_SECRET)`);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status:    'healthy',
  version:   '1.0.0',
  timestamp: new Date().toISOString()
}));

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`Unhandled error on ${req.method} ${req.path}:`, err);

  // Mongoose validation
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Validation failed', details: err.message });
  }
  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    return res.status(409).json({ error: `${field} already exists` });
  }

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  logger.debug(`Socket connected: ${socket.id}`);

  socket.on('subscribe:company', companyId => {
    if (companyId) socket.join(`company:${companyId}`);
  });

  socket.on('disconnect', () => {
    logger.debug(`Socket disconnected: ${socket.id}`);
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  // MongoDB
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30_000,
    connectTimeoutMS:         30_000,
    socketTimeoutMS:          60_000
  });
  logger.info('✅ MongoDB connected');

  // Redis
  await initializeRedis();
  logger.info('✅ Redis connected');

  // Bull queues
  await initializeQueues();
  logger.info('✅ Job queues initialized');

  // Agent orchestrator
  const orchestrator = new AgentOrchestrator(io);
  orchestrator.schedule();
  app.set('orchestrator', orchestrator);
  logger.info('✅ Agent orchestrator scheduled');

  // Start listening
  const PORT = parseInt(process.env.PORT) || 5000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 TenderPro running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
}

bootstrap().catch(err => {
  logger.error('Bootstrap failed:', err);
  process.exit(1);
});

module.exports = { app, io };
