const Queue  = require('bull');
const { logger } = require('../utils/logger');

let queues = {};

function getQueue(name) {
  if (!queues[name]) throw new Error(`Queue '${name}' not initialized`);
  return queues[name];
}

async function initializeQueues() {
  const redis = process.env.REDIS_URL || 'redis://localhost:6379';

  queues.scrape   = new Queue('scrape',   { redis });
  queues.match    = new Queue('match',    { redis });
  queues.notify   = new Queue('notify',   { redis });
  queues.proposal = new Queue('proposal', { redis });
  queues.rag      = new Queue('rag',      { redis });

  // ── Notify worker ──────────────────────────────────────────────────
  queues.notify.process('send-alert', 5, async (job) => {
    const { broadcastTenderAlert } = require('../whatsapp/whatsAppClient');
    await broadcastTenderAlert(job.data.matchId);
    return { sent: true };
  });

  // ── Match worker ───────────────────────────────────────────────────
  queues.match.process('match-company', 2, async (job) => {
    const { AgentOrchestrator } = require('../../agent/orchestrator');
    const orch = new AgentOrchestrator(null);
    await orch._scoutForCompany({ _id: job.data.companyId }, false);
    return { done: true };
  });

  // ── RAG worker ─────────────────────────────────────────────────────
  queues.rag.process('index-document', 2, async (job) => {
    const { RAGService } = require('../../agent/rag/ragService');
    const rag = new RAGService();
    return rag.processUploadedFile(job.data.companyId, job.data.filePath, job.data.documentType);
  });

  queues.rag.process('index-company-profile', 1, async (job) => {
    const { RAGService } = require('../../agent/rag/ragService');
    const rag = new RAGService();
    await rag.indexCompanyProfile(job.data.companyId);
    return { indexed: true };
  });

  for (const [name, q] of Object.entries(queues)) {
    q.on('failed', (job, err) => logger.error(`Queue ${name} job ${job.id} failed: ${err.message}`));
  }

  logger.info('All queues initialized');
}

module.exports = { initializeQueues, getQueue };
