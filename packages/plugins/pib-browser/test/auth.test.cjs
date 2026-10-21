'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { authenticate, ISSUE_RE } = require('../src/auth.cjs');

test('authenticate - ok path with header verification', async () => {
  const headers = [];
  const customFetch = async (url, opts) => {
    headers.push({ url, header: opts?.headers?.Authorization });
    if (url.includes('/agents/me')) {
      return { ok: true, json: async () => ({ id: 'agent-1', companyId: 'c1' }) };
    }
    return { ok: true, json: async () => ({ id: 'issue-1', identifier: 'TEST-123', companyId: 'c1' }) };
  };

  const token = 'sk-test1234567890abcd';
  const result = await authenticate({ token, issue: 'TEST-123' }, { fetch: customFetch, apiBase: 'http://api' });
  assert.equal(result.ok, true);
  assert.equal(result.agentId, 'agent-1');
  assert.equal(result.companyId, 'c1');
  assert.deepEqual(result.issue.identifier, 'TEST-123');
  assert.equal(headers.length, 2);
  assert.equal(headers[0].header, `Bearer ${token}`);
  assert.equal(headers[1].header, `Bearer ${token}`);
});

// Failure cases: token, fetch, company, 404, format
const failureCases = [
  { name: 'missing token', req: { token: '', issue: 'TEST-123' }, expectFetchNever: true, expectedExit: 2 },
  { name: 'bad token 401', req: { token: 'sk-badtoken123456789', issue: 'TEST-123' }, agentFail: true, expectedExit: 7 },
  { name: 'fetch throws', req: { token: 'sk-throwstoken123456', issue: 'TEST-123' }, fetchThrows: true, expectedExit: 7 },
  { name: 'other-company', req: { token: 'sk-othertoken123456789', issue: 'TEST-123' }, wrongCompany: true, expectedExit: 7 },
  { name: 'issue 404', req: { token: 'sk-issuetoken1234567', issue: 'TEST-123' }, issueFail: true, expectedExit: 7 },
  { name: 'bad format (no fetch)', req: { token: 'sk-formattoken12345678', issue: 'invalid' }, expectFetchNever: true, expectedExit: 2 }
];

for (const { name, req, expectFetchNever, agentFail, fetchThrows, wrongCompany, issueFail, expectedExit } of failureCases) {
  test(`authenticate - ${name}`, async () => {
    let callCount = 0;
    const customFetch = async (url, opts) => {
      callCount++;
      if (fetchThrows) throw new Error('network');
      if (url.includes('/agents/me')) {
        if (agentFail) return { ok: false };
        return { ok: true, json: async () => ({ id: 'agent-1', companyId: 'c1' }) };
      }
      if (issueFail) return { ok: false };
      const companyId = wrongCompany ? 'c2' : 'c1';
      return { ok: true, json: async () => ({ id: 'issue-1', identifier: 'TEST-123', companyId }) };
    };

    const result = await authenticate(req, { fetch: customFetch, apiBase: 'http://api' });
    assert.equal(result.exit, expectedExit);
    if (expectFetchNever) assert.equal(callCount, 0);
    if (req.token) assert(!JSON.stringify(result).includes(req.token), 'token leaked in result');
  });
}

test('ISSUE_RE format', () => {
  assert(ISSUE_RE.test('TEST-123'));
  assert(!ISSUE_RE.test('invalid'));
});
