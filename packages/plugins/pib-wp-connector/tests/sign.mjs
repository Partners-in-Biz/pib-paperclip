#!/usr/bin/env node
// Produce a PiB Connector request signature (same algorithm as PROTOCOL.md).
//
//   node tests/sign.mjs <key> <ts> <nonce> <route> <body>
//   node tests/sign.mjs --vector      # prints the fixed test vector used by tests/test-auth.php
import { createHash, createHmac } from 'node:crypto';

export function keyId(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

export function stringToSign(ts, nonce, route, body) {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return [String(ts), nonce, 'POST', route, bodyHash].join('\n');
}

export function sign(key, ts, nonce, route, body) {
  return createHmac('sha256', key).update(stringToSign(ts, nonce, route, body), 'utf8').digest('hex');
}

export const VECTOR = {
  key: 'pibc_' + Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url'),
  ts: '1767225600',
  nonce: '0123456789abcdef0123456789abcdef',
  route: '/pib-connector/v1/seo/get',
  body: '{"url":"/about/"}',
};

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sign.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === '--vector' || args.length === 0) {
    const v = VECTOR;
    console.log(JSON.stringify({ ...v, keyId: keyId(v.key), bodyHash: createHash('sha256').update(v.body).digest('hex'), signature: sign(v.key, v.ts, v.nonce, v.route, v.body) }, null, 2));
  } else if (args.length === 5) {
    const [key, ts, nonce, route, body] = args;
    console.log(sign(key, ts, nonce, route, body));
  } else {
    console.error('usage: node tests/sign.mjs <key> <ts> <nonce> <route> <body> | --vector');
    process.exit(2);
  }
}
