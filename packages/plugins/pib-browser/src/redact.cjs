'use strict';
const RULES = [
  /\bBearer\s+\S+/gi,
  /\b(?:authorization|password|passwd|secret|token|api[_-]?key|cookie)\s*[=:]\s*\S+/gi,
  /\b[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}\b/g,
  /\b(?=[\w-]*[A-Za-z])(?=[\w-]*\d)[\w-]{32,}\b/g,
];
const redactText = (t) => (typeof t === 'string' ? RULES.reduce((s, r) => s.replace(r, '[redacted]'), t) : '');
function parseRegion(s) {
  if (typeof s !== 'string' || !/^\d+,\d+,\d+,\d+$/.test(s)) return null;
  const [x, y, w, h] = s.split(',').map(Number);
  return w > 0 && h > 0 && w <= 20000 && h <= 20000 ? { x, y, w, h } : null;
}
module.exports = { redactText, parseRegion };
