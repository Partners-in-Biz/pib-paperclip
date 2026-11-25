'use strict';
const { redactText } = require('./redact.cjs');

// Bounds for --viewport WxH (PAR-14608).
const VIEWPORT_MIN = { w: 320, h: 320 };
const VIEWPORT_MAX = { w: 3840, h: 2160 };
const MAX_ENTRIES = 1000;

function parseViewport(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(s.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < VIEWPORT_MIN.w || w > VIEWPORT_MAX.w || h < VIEWPORT_MIN.h || h > VIEWPORT_MAX.h) return null;
  return { width: w, height: h };
}

// A URL that is safe to write down: no credentials, no fragment, query keys kept but every value
// replaced, and path segments that look like tokens run through the text redactor.
function redactUrl(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return `${u.protocol}[redacted]`;
    const path = u.pathname.split('/').map((seg) => {
      let d = seg;
      try { d = decodeURIComponent(seg); } catch (e) {}
      return redactText(d) === d ? seg : '[redacted]';
    }).join('/');
    const keys = [];
    for (const k of u.searchParams.keys()) {
      const safe = redactText(k) === k ? k : '[redacted]';
      keys.push(`${encodeURIComponent(safe).replace(/%5B/g, '[').replace(/%5D/g, ']')}=[redacted]`);
    }
    return u.origin + path + (keys.length ? `?${keys.join('&')}` : '');
  } catch (e) {
    return '[unparseable]';
  }
}

// Method, redacted URL, status and time only. Never headers, cookies or bodies.
function createNetLog({ max = MAX_ENTRIES, now = () => new Date() } = {}) {
  const entries = [];
  return {
    add({ url, method, status }) {
      entries.push({
        time: now().toISOString(),
        method: String(method || 'GET').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) || 'GET',
        url: redactUrl(url),
        status: Number.isInteger(status) ? status : 0
      });
      if (entries.length > max) entries.shift();
    },
    entries: () => entries.map((e) => ({ ...e })),
    clear: () => { entries.length = 0; }
  };
}

module.exports = { parseViewport, redactUrl, createNetLog, VIEWPORT_MIN, VIEWPORT_MAX, MAX_ENTRIES };
