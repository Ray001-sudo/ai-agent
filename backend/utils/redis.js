const { createClient } = require('redis');
const { logger } = require('./logger');

let client = null;

async function initializeRedis() {
  client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  client.on('error', err => logger.error('Redis error:', err));
  await client.connect();
  return client;
}

function getRedisClient() { return client; }

module.exports = { initializeRedis, getRedisClient };
