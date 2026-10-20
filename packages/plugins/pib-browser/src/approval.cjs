'use strict';
const { EXIT } = require('./exit-codes.cjs');
const { ISSUE_RE } = require('./auth.cjs');

function createApprovalStore({ stateDir, fs = require('node:fs'), path = require('node:path') } = {}) {
  if (!stateDir) throw new Error('stateDir required');
  const approvalsDir = path.join(stateDir, 'approvals-used');
  return {
    claim(issueId) {
      if (!/^[A-Z]+-\d+$/.test(issueId)) return false;
      try {
        try {
          fs.mkdirSync(approvalsDir, { mode: 0o700, recursive: true });
        } catch (e) {
          if (e.code !== 'EEXIST') return false;
        }
        const filePath = path.join(approvalsDir, issueId);
        const fd = fs.openSync(filePath, 'wx');
        fs.closeSync(fd);
        return true;
      } catch (e) {
        return e.code === 'EEXIST' ? false : false;
      }
    }
  };
}

async function verifyApproval(
  { approval, identity, action, companyId },
  { fetch, apiBase, token, clock, store, maxAgeMs = 24 * 3600 * 1000 }
) {
  try {
    // Fail closed: validate clock is correctly formed
    if (typeof clock?.now !== 'function') {
      return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_lookup_failed' };
    }

    if (!ISSUE_RE.test(approval)) return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'bad_approval_id' };
    const actions = Array.isArray(action) ? action.filter(Boolean) : (action ? [action].filter(Boolean) : []);

    let issueRes;
    try {
      issueRes = await fetch(`${apiBase}/api/issues/${approval}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {
      return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_lookup_failed' };
    }
    if (!issueRes.ok) return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_not_found' };
    const issue = await issueRes.json();

    if (issue.companyId !== companyId) return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_other_company' };
    if (issue.status !== 'done') return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_not_done' };

    const completedAt = new Date(issue.completedAt).getTime();
    if (isNaN(completedAt)) return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_not_done' };
    const now = clock.now();
    // Fail closed: ensure both now and completedAt are finite numbers
    if (!Number.isFinite(now) || !Number.isFinite(completedAt)) {
      return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_lookup_failed' };
    }
    const age = now - completedAt;
    // Use strict numeric bounds: NaN will fail both comparisons
    if (!(age >= 0 && age <= maxAgeMs)) return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_stale' };

    let activityRes;
    try {
      activityRes = await fetch(`${apiBase}/api/issues/${approval}/activity`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {
      return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_lookup_failed' };
    }
    if (!activityRes.ok) return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_lookup_failed' };

    let activity = await activityRes.json();
    if (activity.activity && Array.isArray(activity.activity)) activity = activity.activity;
    if (!Array.isArray(activity)) activity = [];

    const doneEntries = activity.filter(e => {
      if (e.action !== 'issue.updated') return false;
      if (!e.details) return false;
      return e.details.status === 'done' || e.details.changes?.status?.to === 'done';
    });
    if (doneEntries.length === 0) return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_not_closed_by_human' };

    const latestDone = doneEntries.reduce((latest, current) => {
      const ct = new Date(current.createdAt).getTime();
      const lt = new Date(latest.createdAt).getTime();
      return ct > lt ? current : latest;
    });
    if (latestDone.actorType !== 'user') return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_not_closed_by_human' };

    let markerText = issue.description || '';
    let commentsRes;
    try {
      commentsRes = await fetch(`${apiBase}/api/issues/${approval}/comments`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {}

    if (commentsRes?.ok) {
      let comments = await commentsRes.json();
      if (comments.comments && Array.isArray(comments.comments)) comments = comments.comments;
      if (Array.isArray(comments)) {
        comments.forEach(c => {
          if (c.createdAt && new Date(c.createdAt).getTime() <= completedAt) {
            markerText += ' ' + (c.body || '');
          }
        });
      }
    }

    const normalizedText = markerText.toLowerCase().replace(/\s+/g, ' ').trim();
    const normalizedId = identity.toLowerCase();
    let foundMarker = false;

    for (const cand of actions) {
      const marker = `approval for ${normalizedId}:${cand.toLowerCase()}`;
      const idx = normalizedText.indexOf(marker);
      if (idx !== -1) {
        const afterIdx = idx + marker.length;
        const isEof = afterIdx === normalizedText.length;
        const charAfter = normalizedText[afterIdx];
        if (isEof || /\s|[.,;)]/.test(charAfter)) {
          foundMarker = true;
          break;
        }
      }
    }

    if (!foundMarker) return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_marker_missing' };
    if (!store.claim(approval)) return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_already_used' };
    return { ok: true };
  } catch {
    return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_lookup_failed' };
  }
}

module.exports = { createApprovalStore, verifyApproval };
