'use strict';
const ISSUE_RE = /^[A-Z]+-\d+$/;
const EXIT = { USAGE: 2, REFUSED_BY_POLICY: 7 };

async function authenticate({ token, issue } = {}, { fetch, apiBase } = {}) {
  if (!token || typeof token !== 'string') return { exit: EXIT.USAGE, ok: false, reason: 'no_token' };
  if (!issue || !ISSUE_RE.test(issue)) return { exit: EXIT.USAGE, ok: false, reason: 'invalid_issue' };
  try {
    const agentReq = await fetch(`${apiBase}/api/agents/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!agentReq.ok) return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'agent_auth_failed' };
    const agent = await agentReq.json();
    const issueReq = await fetch(`${apiBase}/api/issues/${issue}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!issueReq.ok) return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'issue_not_found' };
    const issueData = await issueReq.json();
    if (agent.companyId !== issueData.companyId) return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'company_mismatch' };
    return { ok: true, agentId: agent.id, companyId: agent.companyId, issue: issueData };
  } catch (e) {
    return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'fetch_error' };
  }
}

module.exports = { authenticate, ISSUE_RE };
