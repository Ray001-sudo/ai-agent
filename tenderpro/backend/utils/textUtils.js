const sanitizeHtml = require('sanitize-html');

function sanitizeText(text) {
  if (!text) return '';
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} }).trim().replace(/\s+/g, ' ');
}

function maskPII(text) {
  return text
    .replace(/\b[\w.-]+@[\w.-]+\.\w{2,4}\b/g, '[EMAIL]')
    .replace(/\b\+?[0-9]{10,15}\b/g, '[PHONE]');
}

module.exports = { sanitizeText, maskPII };
