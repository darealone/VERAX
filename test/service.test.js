import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { loadConfig } from '../src/config.js';

function setup() {
  let now = Date.UTC(2026, 10, 16, 9);
  const db = openDb(':memory:');
  const crm = { fixed: false };
  const fetchImpl = async (url, init) => {
    const body = init.method === 'POST' ? { ok: true } : (crm.fixed ? { email: 'x', company_size: '50' } : { email: 'x' });
    return { status: 200, url, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer };
  };
  const svc = createService(db, loadConfig(null), { clock: () => now, fetch: fetchImpl, sleep: async () => {} });
  const admin = svc.createUser(null, { email: 'a@x.test', name: 'Admin', password: 'password-123' });
  const approver = svc.createUser(admin, { email: 'b@x.test', name: 'Approver', role: 'approver', password: 'password-123' });
  const member = svc.createUser(admin, { email: 'c@x.test', name: 'Member', role: 'member', password: 'password-123' });
  return { db, svc, admin, approver, member, crm, tick: ms => { now += ms; } };
}

const mappingCheck = { label: 'Form → CRM', type: 'roundtrip', critical: true, config: { submit: { url: 'https://f.test', method: 'POST', body: {} }, verify: { url: 'https://c.test/{{testId}}', retries: 1, waitMs: 0 }, expect: { company_size: '50' } } };

test('R01 end to end: BLOCKED → fix → re-run → NEEDS_REVIEW → approval → GO', async () => {
  const { svc, member, approver, crm } = setup();
  const { launch } = svc.createLaunch(member, { name: 'Webinar' });
  const check = svc.addCheck(member, launch.id, mappingCheck);

  let ev = await svc.runChecks(member, launch.id);
  assert.equal(ev.status, 'BLOCKED');
  assert.throws(() => svc.decide(approver, launch.id, { decision: 'approved' }), e => e.code === 'CANNOT_APPROVE_BLOCKED');

  crm.fixed = true;
  ev = await svc.runChecks(member, launch.id, { checkId: check.id });
  assert.equal(ev.status, 'NEEDS_REVIEW');

  ev = svc.decide(approver, launch.id, { decision: 'approved', note: 'ok' });
  assert.equal(ev.status, 'GO');
});

test('editing a check after approval makes the approval stale', async () => {
  const { svc, member, approver, crm } = setup();
  crm.fixed = true;
  const { launch } = svc.createLaunch(member, { name: 'L' });
  const c = svc.addCheck(member, launch.id, mappingCheck);
  await svc.runChecks(member, launch.id);
  assert.equal(svc.decide(approver, launch.id, { decision: 'approved' }).status, 'GO');
  svc.updateCheck(member, c.id, { label: 'Form → CRM v2' });
  assert.equal(svc.evaluateLaunch(launch.id).approvalState, 'stale');
});

test('permissions: members cannot approve, owners cannot self-approve, critical checks cannot be waived', async () => {
  const { svc, member, approver } = setup();
  const own = svc.createLaunch(approver, { name: 'Mine' }).launch;
  assert.throws(() => svc.decide(member, own.id, { decision: 'approved' }), e => e.code === 'FORBIDDEN');
  assert.throws(() => svc.decide(approver, own.id, { decision: 'approved' }), e => e.code === 'FOUR_EYES');
  const c = svc.addCheck(approver, own.id, mappingCheck);
  assert.throws(() => svc.acceptGap(approver, c.id, { reason: 'trust me' }), e => e.code === 'CRITICAL_CHECK_CANNOT_BE_WAIVED');
});

test('manual checks need evidence from a named person', () => {
  const { svc, member } = setup();
  const { launch } = svc.createLaunch(member, { name: 'Manual' });
  const c = svc.addCheck(member, launch.id, { label: 'Tracking', type: 'manual', critical: true, config: {} });
  assert.throws(() => svc.attest(member, c.id, { status: 'pass', note: '' }), e => e.code === 'EVIDENCE_REQUIRED');
  const ev = svc.attest(member, c.id, { status: 'pass', note: 'Saw conversion with utm_campaign in debug view' });
  assert.equal(ev.reasons.find(r => r.checkId === c.id), undefined);
});

test('results expire: a pass older than maxCheckAgeHours blocks again', async () => {
  const { svc, member, crm, tick } = setup();
  crm.fixed = true;
  const { launch } = svc.createLaunch(member, { name: 'L' });
  svc.addCheck(member, launch.id, mappingCheck);
  await svc.runChecks(member, launch.id);
  tick(25 * 3600_000);
  assert.equal(svc.evaluateLaunch(launch.id).reasons[0].code, 'CHECK_STALE');
});

test('reviews need a person, a note and a future deadline', () => {
  const { svc, member, approver, tick } = setup();
  const { launch } = svc.createLaunch(member, { name: 'L' });
  assert.throws(() => svc.assignReview(member, launch.id, { assignee_id: approver.id, note: '' }), e => e.code === 'NOTE_REQUIRED');
  const d = svc.assignReview(member, launch.id, { assignee_id: approver.id, note: 'Decide on tracking gap' });
  assert.equal(d.reviews[0].overdue, false);
  tick(10 * 864e5);
  assert.equal(svc.getLaunch(member, launch.id).reviews[0].overdue, true);
});

test('audit log is hash-chained and detects tampering', async () => {
  const { db, svc, member } = setup();
  svc.createLaunch(member, { name: 'L' });
  assert.equal(db.verifyAudit().ok, true);
  db.run("UPDATE audit SET data = '{\"name\":\"changed\"}' WHERE action = 'launch.created'");
  assert.equal(db.verifyAudit().ok, false);
});

test('first user becomes admin; later users need an admin', () => {
  const { svc, member } = setup();
  assert.throws(() => svc.createUser(member, { email: 'z@x.test', name: 'Z', password: 'password-123' }), e => e.code === 'FORBIDDEN');
});

test('a person cannot mark a failing automated check as passed', async () => {
  const { svc, member } = setup();
  const { launch } = svc.createLaunch(member, { name: 'L' });
  const c = svc.addCheck(member, launch.id, mappingCheck);
  await svc.runChecks(member, launch.id);
  assert.throws(() => svc.attest(member, c.id, { status: 'pass', note: 'looks fine to me' }), e => e.code === 'AUTOMATED_CHECK_NEEDS_RUN');
  assert.equal(svc.attest(member, c.id, { status: 'fail', note: 'seen broken in CRM' }).status, 'BLOCKED');
});
