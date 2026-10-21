'use strict';
const { EXIT } = require('./exit-codes.cjs');
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const fail = (reason) => ({ exit: EXIT.REFUSED_BY_POLICY, reason });
function parseIdentity(str) {
  if (typeof str !== 'string') return null;
  const p = str.split(':');
  const id = /^[a-z0-9][a-z0-9-]{0,40}$/i;
  if (p[0] === 'pib' && p.length === 2 && id.test(p[1])) return { kind: 'pib', svc: p[1] };
  if (p[0] === 'client' && p.length === 3 && id.test(p[1]) && id.test(p[2])) return { kind: 'client', companyId: p[1], svc: p[2] };
  if (p[0] === 'canary' && p.length === 2 && p[1] === 'wp') return { kind: 'canary', svc: 'wp' };
  return null;
}
function validatePolicy(obj) {
  if (!isPlain(obj) || obj.version !== 1 || !isPlain(obj.agents) || !isPlain(obj.identities))
    return { ok: false, reason: 'policy must be an object' };
  for (const aid in obj.agents) {
    const a = obj.agents[aid];
    if (!isPlain(a) || !Array.isArray(a.identities))
      return { ok: false, reason: 'agent must be an object' };
    for (const id of a.identities)
      if (typeof id !== 'string' || !parseIdentity(id))
        return { ok: false, reason: 'agent identity invalid' };
  }
  for (const ikey in obj.identities) {
    const i = obj.identities[ikey];
    if (!isPlain(i) || !Array.isArray(i.origins))
      return { ok: false, reason: 'identity must be a plain object' };
    for (const o of i.origins) {
      if (typeof o !== 'string') return { ok: false, reason: 'origin must be a string' };
      try {
        const u = new URL(o);
        if (u.origin !== o || !/^https?:$/.test(u.protocol) ||
            (u.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(u.hostname)))
          return { ok: false, reason: 'origin url invalid' };
      } catch (e) {
        return { ok: false, reason: 'origin url invalid' };
      }
    }
  }
  return { ok: true };
}
function loadPolicy(f, fs) {
  try {
    const p = JSON.parse((fs || require('node:fs')).readFileSync(f, 'utf8'));
    const v = validatePolicy(p);
    return v.ok ? { ok: true, policy: p } : { ok: false, reason: v.reason };
  } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'policy file not found' : 'policy load failed' };
  }
}
function originsFor({ policy, sites, identity }) {
  if (!policy?.identities) return [];
  if (policy.identities[identity]?.origins) return policy.identities[identity].origins;
  const p = parseIdentity(identity);
  return (p?.kind === 'pib' && sites?.sites?.[p.svc]?.origins) || [];
}
function authorise({ policy, sites, agentId, identity, url, click, approved }) {
  const v = validatePolicy(policy);
  if (!v.ok) return fail('policy invalid');
  if (!agentId || typeof agentId !== 'string') return fail('agent invalid');
  if (!Object.prototype.hasOwnProperty.call(policy.agents, agentId)) return fail('agent not found');
  const a = policy.agents[agentId];
  if (!a.identities?.includes(identity)) return fail('identity not allowed');
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || (u.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(u.hostname)))
      return fail('protocol not allowed');
    if (u.username || u.password) return fail('credentials in url');
    const o = originsFor({ policy, sites, identity });
    if (!o.includes(u.origin)) return fail('origin not allowed');
  } catch (e) {
    return fail('url invalid');
  }
  if (click) {
    if (!sites) return { exit: EXIT.NEEDS_APPROVAL, reason: 'needs_approval' };
    const p = parseIdentity(identity);
    if (!p?.kind || !sites.sites?.[p.svc]) return { exit: EXIT.NEEDS_APPROVAL, reason: 'needs_approval' };
    const s = sites.sites[p.svc];
    if (isDestructive(s, click) && approved !== true)
      return { exit: EXIT.NEEDS_APPROVAL, reason: 'needs_approval' };
  }
  return { ok: true };
}
function isDestructive(site, { selector, text }) {
  if (!site?.destructive) return false;
  if (selector && typeof selector === 'string') {
    const ns = selector.trim().toLowerCase();
    for (const ds of (site.destructive.selectors || []))
      if (typeof ds === 'string' && (ns === ds.toLowerCase() || ns.includes(ds.toLowerCase())))
        return true;
  }
  if (text && typeof text === 'string') {
    const nt = text.trim().toLowerCase().replace(/\s+/g, ' ');
    for (const dt of (site.destructive.text || []))
      if (typeof dt === 'string' && nt.includes(dt.toLowerCase()))
        return true;
  }
  return false;
}
module.exports = { parseIdentity, validatePolicy, loadPolicy, originsFor, authorise, isDestructive };
