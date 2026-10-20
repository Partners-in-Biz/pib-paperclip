'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createApprovalStore, verifyApproval } = require('../src/approval.cjs');
const { EXIT } = require('../src/exit-codes.cjs');

function makeFakeFetch(responses = {}) {
  return async (url, opts) => {
    const resp = responses[url];
    if (!resp) throw new Error(`No mock for ${url}`);
    if (resp.throw) throw new Error(resp.throw);
    return {
      ok: resp.ok,
      status: resp.status,
      json: async () => resp.data
    };
  };
}

test('valid approval succeeds once, fails second time with already_used', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-123': { ok: true, data: { id: 'PAR-123', status: 'done', companyId: 'c1', description: 'approval for user1:delete-widget', completedAt: new Date(now - 1000).toISOString() } },
    'http://api/api/issues/PAR-123/activity': { ok: true, data: [{ id: 'a1', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } }] },
    'http://api/api/issues/PAR-123/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r1 = await verifyApproval({ approval: 'PAR-123', identity: 'user1', action: 'delete-widget', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r1.ok, true);
  const r2 = await verifyApproval({ approval: 'PAR-123', identity: 'user1', action: 'delete-widget', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r2.reason, 'approval_already_used');
  fs.rmSync(tmp, { recursive: true });
});

test('agent-closed approval fails and does not consume claim', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-456': { ok: true, data: { id: 'PAR-456', status: 'done', companyId: 'c1', description: 'approval for user1:publish', completedAt: new Date(now - 1000).toISOString() } },
    'http://api/api/issues/PAR-456/activity': { ok: true, data: [{ id: 'a1', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'agent', actorId: 'ag1', details: { changes: { status: { from: 'open', to: 'done' } } } }] },
    'http://api/api/issues/PAR-456/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-456', identity: 'user1', action: 'publish', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.reason, 'approval_not_closed_by_human');
  assert.equal(store.claim('PAR-456'), true, 'Claim should succeed since not consumed');
  fs.rmSync(tmp, { recursive: true });
});

test('agent-created but human-closed passes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-789': { ok: true, data: { id: 'PAR-789', status: 'done', companyId: 'c1', description: 'approval for user1:execute', completedAt: new Date(now - 1000).toISOString() } },
    'http://api/api/issues/PAR-789/activity': { ok: true, data: [{ id: 'c1', action: 'issue.created', createdAt: new Date(now - 5000).toISOString(), actorType: 'agent', actorId: 'ag1', details: {} }, { id: 'u1', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } }] },
    'http://api/api/issues/PAR-789/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-789', identity: 'user1', action: 'execute', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.ok, true);
  fs.rmSync(tmp, { recursive: true });
});

test('approval for another identity fails with marker_missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-111': { ok: true, data: { id: 'PAR-111', status: 'done', companyId: 'c1', description: 'approval for user2:delete', completedAt: new Date(now - 1000).toISOString() } },
    'http://api/api/issues/PAR-111/activity': { ok: true, data: [{ id: 'a1', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } }] },
    'http://api/api/issues/PAR-111/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-111', identity: 'user1', action: 'delete', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.reason, 'approval_marker_missing');
  fs.rmSync(tmp, { recursive: true });
});

test('prefix case: #publish does not match #publish-all', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-222': { ok: true, data: { id: 'PAR-222', status: 'done', companyId: 'c1', description: 'approval for user1:#publish-all', completedAt: new Date(now - 1000).toISOString() } },
    'http://api/api/issues/PAR-222/activity': { ok: true, data: [{ id: 'a1', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } }] },
    'http://api/api/issues/PAR-222/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-222', identity: 'user1', action: '#publish', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.reason, 'approval_marker_missing');
  fs.rmSync(tmp, { recursive: true });
});

test('25h old approval fails with stale', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const completedMs = Date.now() - (25 * 3600 * 1000);
  const responses = {
    'http://api/api/issues/PAR-333': { ok: true, data: { id: 'PAR-333', status: 'done', companyId: 'c1', description: 'approval for user1:old-action', completedAt: new Date(completedMs).toISOString() } },
    'http://api/api/issues/PAR-333/activity': { ok: true, data: [{ id: 'a1', action: 'issue.updated', createdAt: new Date(completedMs).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } }] },
    'http://api/api/issues/PAR-333/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-333', identity: 'user1', action: 'old-action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => Date.now() }, store });
  assert.equal(r.reason, 'approval_stale');
  fs.rmSync(tmp, { recursive: true });
});

test('not done status fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const responses = {
    'http://api/api/issues/PAR-444': { ok: true, data: { id: 'PAR-444', status: 'open', companyId: 'c1', description: 'approval for user1:something', completedAt: null } }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-444', identity: 'user1', action: 'something', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => Date.now() }, store });
  assert.equal(r.reason, 'approval_not_done');
  fs.rmSync(tmp, { recursive: true });
});

test('other company fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-555': { ok: true, data: { id: 'PAR-555', status: 'done', companyId: 'c2', description: 'approval for user1:action', completedAt: new Date(now - 1000).toISOString() } }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-555', identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.reason, 'approval_other_company');
  fs.rmSync(tmp, { recursive: true });
});

test('fetch reject fails with approval_lookup_failed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const fetch = async () => { throw new Error('Network error'); };
  const r = await verifyApproval({ approval: 'PAR-666', identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => Date.now() }, store });
  assert.equal(r.reason, 'approval_lookup_failed');
  fs.rmSync(tmp, { recursive: true });
});

test('bad approval ID format', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const fetch = makeFakeFetch({});
  const badIds = ['../PAR-123', 'PAR-abc', '123-PAR', 'x', '', 'PAR123'];
  for (const bid of badIds) {
    const r = await verifyApproval({ approval: bid, identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => Date.now() }, store });
    assert.equal(r.reason, 'bad_approval_id', `Should reject ${bid}`);
  }
  fs.rmSync(tmp, { recursive: true });
});

test('store rejects path traversal', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  assert.equal(store.claim('../x'), false);
  fs.rmSync(tmp, { recursive: true });
});

test('marker only in comment after completedAt fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const completedMs = now - 5000;
  const responses = {
    'http://api/api/issues/PAR-777': { ok: true, data: { id: 'PAR-777', status: 'done', companyId: 'c1', description: '', completedAt: new Date(completedMs).toISOString() } },
    'http://api/api/issues/PAR-777/activity': { ok: true, data: [{ id: 'a1', action: 'issue.updated', createdAt: new Date(completedMs).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } }] },
    'http://api/api/issues/PAR-777/comments': { ok: true, data: [{ body: 'approval for user1:late-action', createdAt: new Date(completedMs + 10000).toISOString() }] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-777', identity: 'user1', action: 'late-action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.reason, 'approval_marker_missing');
  fs.rmSync(tmp, { recursive: true });
});

test('token never leaks in returned value', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const testToken = 'super-secret-token-xyz-abc-123';
  const responses = {
    'http://api/api/issues/PAR-888': { ok: true, data: { id: 'PAR-888', status: 'done', companyId: 'c1', description: 'approval for user1:action', completedAt: new Date(now - 1000).toISOString() } },
    'http://api/api/issues/PAR-888/activity': { ok: true, data: [{ id: 'a1', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } }] },
    'http://api/api/issues/PAR-888/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-888', identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: testToken, clock: { now: () => now }, store });
  assert(!JSON.stringify(r).includes(testToken), 'Token should not leak');
  fs.rmSync(tmp, { recursive: true });
});

test('reopened then agent-closed fails with not_closed_by_human', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-999': { ok: true, data: { id: 'PAR-999', status: 'done', companyId: 'c1', description: 'approval for user1:action', completedAt: new Date(now - 1000).toISOString() } },
    'http://api/api/issues/PAR-999/activity': { ok: true, data: [
      { id: 'a1', action: 'issue.updated', createdAt: new Date(now - 5000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } },
      { id: 'a2', action: 'issue.updated', createdAt: new Date(now - 3000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'done', to: 'open' } } } },
      { id: 'a3', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'agent', actorId: 'ag1', details: { changes: { status: { from: 'open', to: 'done' } } } }
    ] },
    'http://api/api/issues/PAR-999/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-999', identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.reason, 'approval_not_closed_by_human');
  fs.rmSync(tmp, { recursive: true });
});

test('approval not found', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const responses = {
    'http://api/api/issues/PAR-404': { ok: false, status: 404, data: {} }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-404', identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => Date.now() }, store });
  assert.equal(r.reason, 'approval_not_found');
  fs.rmSync(tmp, { recursive: true });
});

test('description marker + agent issue.updated after human close => fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-1001': { ok: true, data: { id: 'PAR-1001', status: 'done', companyId: 'c1', description: 'approval for user1:action', completedAt: new Date(now - 5000).toISOString() } },
    'http://api/api/issues/PAR-1001/activity': { ok: true, data: [
      { id: 'a1', action: 'issue.updated', createdAt: new Date(now - 5000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } },
      { id: 'a2', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'agent', actorId: 'ag1', details: { changes: { title: { from: 'old', to: 'new' } } } }
    ] },
    'http://api/api/issues/PAR-1001/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-1001', identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.reason, 'approval_marker_missing');
  fs.rmSync(tmp, { recursive: true });
});

test('description marker, agent-created, human-closed, no later entries => passes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-1002': { ok: true, data: { id: 'PAR-1002', status: 'done', companyId: 'c1', description: 'approval for user1:action', completedAt: new Date(now - 1000).toISOString() } },
    'http://api/api/issues/PAR-1002/activity': { ok: true, data: [
      { id: 'c1', action: 'issue.created', createdAt: new Date(now - 5000).toISOString(), actorType: 'agent', actorId: 'ag1', details: {} },
      { id: 'a1', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } }
    ] },
    'http://api/api/issues/PAR-1002/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-1002', identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.ok, true);
  fs.rmSync(tmp, { recursive: true });
});

test('description marker + later user issue.updated => still passes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-1003': { ok: true, data: { id: 'PAR-1003', status: 'done', companyId: 'c1', description: 'approval for user1:action', completedAt: new Date(now - 5000).toISOString() } },
    'http://api/api/issues/PAR-1003/activity': { ok: true, data: [
      { id: 'a1', action: 'issue.updated', createdAt: new Date(now - 5000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } },
      { id: 'a2', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { title: { from: 'old', to: 'new' } } } }
    ] },
    'http://api/api/issues/PAR-1003/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-1003', identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.ok, true);
  fs.rmSync(tmp, { recursive: true });
});

test('activity list in reverse order still picks newest done entry', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-1006': { ok: true, data: { id: 'PAR-1006', status: 'done', companyId: 'c1', description: 'approval for user1:action', completedAt: new Date(now - 1000).toISOString() } },
    'http://api/api/issues/PAR-1006/activity': { ok: true, data: [
      { id: 'a3', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'agent', actorId: 'ag1', details: { changes: { status: { from: 'open', to: 'done' } } } },
      { id: 'a2', action: 'issue.updated', createdAt: new Date(now - 3000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'done', to: 'open' } } } },
      { id: 'a1', action: 'issue.updated', createdAt: new Date(now - 5000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } }
    ] },
    'http://api/api/issues/PAR-1006/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-1006', identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.reason, 'approval_not_closed_by_human');
  fs.rmSync(tmp, { recursive: true });
});

test('description marker + human close + agent issue.updated with unparseable createdAt => fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const store = createApprovalStore({ stateDir: tmp, fs, path });
  const now = Date.now();
  const responses = {
    'http://api/api/issues/PAR-1007': { ok: true, data: { id: 'PAR-1007', status: 'done', companyId: 'c1', description: 'approval for user1:action', completedAt: new Date(now - 5000).toISOString() } },
    'http://api/api/issues/PAR-1007/activity': { ok: true, data: [
      { id: 'a1', action: 'issue.updated', createdAt: new Date(now - 5000).toISOString(), actorType: 'user', actorId: 'u1', details: { changes: { status: { from: 'open', to: 'done' } } } },
      { id: 'a2', action: 'issue.updated', createdAt: 'not-a-date', actorType: 'agent', actorId: 'ag1', details: { changes: { title: { from: 'old', to: 'new' } } } }
    ] },
    'http://api/api/issues/PAR-1007/comments': { ok: true, data: [] }
  };
  const fetch = makeFakeFetch(responses);
  const r = await verifyApproval({ approval: 'PAR-1007', identity: 'user1', action: 'action', companyId: 'c1' }, { fetch, apiBase: 'http://api', token: 'tk', clock: { now: () => now }, store });
  assert.equal(r.reason, 'approval_marker_missing');
  fs.rmSync(tmp, { recursive: true });
});
