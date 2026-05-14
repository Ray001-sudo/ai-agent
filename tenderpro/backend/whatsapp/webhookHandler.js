const express = require('express');
const router  = express.Router();
const twilio  = require('twilio');
const { handleIncomingMessage } = require('./whatsAppClient');
const { logger } = require('../utils/logger');

router.post('/', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
  try {
    const { From, Body, MediaUrl0, MediaContentType0 } = req.body;
    const phone   = (From || '').replace('whatsapp:', '');
    const isVoice = (MediaContentType0 || '').includes('audio');
    logger.info(`📩 WA from ${phone}: ${(Body || '').substring(0, 50)}`);
    setImmediate(() => handleIncomingMessage(phone, Body || '', MediaUrl0 || null, isVoice).catch(e => logger.error('Handler error:', e.message)));
  } catch (e) { logger.error('Webhook error:', e.message); }
});

router.post('/status', (req, res) => {
  logger.info(`WA delivery: ${req.body.MessageSid} → ${req.body.MessageStatus}`);
  res.sendStatus(204);
});

module.exports = router;
