'use strict';
function createFakeBrowser(graph = {}) {
  let lastCtx = null;
  function newContext({ origins = [], guard }) {
    let currentUrl = null;
    const violations = [];
    const performed = [];
    const parseUrl = (u) => { try { return new URL(u, currentUrl || 'https://example.com'); } catch (e) { return null; } };
    const checkGuard = (u, k) => {
      const p = parseUrl(u);
      if (!guard || guard(u, k)) return true;
      violations.push({ url: p?.href || u || 'unknown', kind: k });
      return false;
    };
    const goto = async (u) => {
      const p = parseUrl(u);
      if (!p) throw new Error(`Invalid URL: ${u}`);
      if (!checkGuard(p.href, 'navigation')) return;
      const page = graph[p.href];
      if (page?.redirect && !checkGuard(new URL(page.redirect, p.href).href, 'redirect')) return;
      if (page?.subresources) page.subresources.forEach(s => checkGuard(new URL(s, p.href).href, 'subresource'));
      currentUrl = p.href;
      performed.push({ cmd: 'goto', url: p.href });
    };
    const click = async (sel, txt) => {
      if (!currentUrl) throw new Error('No page loaded');
      const page = graph[currentUrl];
      if (page?.links?.[sel]) {
        const tgt = new URL(page.links[sel], currentUrl).href;
        if (checkGuard(tgt, 'link')) performed.push({ cmd: 'click', type: 'link', url: tgt });
      }
      if (page?.popups?.[sel]) {
        const tgt = new URL(page.popups[sel], currentUrl).href;
        if (checkGuard(tgt, 'popup')) performed.push({ cmd: 'click', type: 'popup', url: tgt });
      }
    };
    const text = async (sel) => (graph[currentUrl]?.text || '');
    const hasText = async (s) => { const p = graph[currentUrl]; return p ? (p.text || '').includes(s) : false; };
    const describe = async (sel) => graph[currentUrl]?.fields?.[sel] || { type: 'text', autocomplete: '' };
    const url = () => currentUrl;
    let closeCount = 0;
    const ctx = {
      goto, click,
      fill: async () => { if (!currentUrl) throw new Error('No page loaded'); },
      text, shot: async (p) => { if (!currentUrl) throw new Error('No page loaded'); return p; }, hasText,
      describe, url,
      violations: () => violations, performed: () => performed,
      close: async () => { currentUrl = null; closeCount++; },
      _closeCount: () => closeCount
    };
    lastCtx = ctx;
    return ctx;
  }
  return { newContext, lastContext: () => lastCtx };
}
module.exports = { createFakeBrowser };
