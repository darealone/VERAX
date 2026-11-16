import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, fingerprint, STATUS } from '../src/rules.js';

const NOW = Date.UTC(2026, 10, 16, 12);
const H = 3600_000;
const launch = { id: 1, name: 'Webinar', scope: 'Form to CRM', owner_id: 1 };
const checks = [
  { id: 1, label: 'CTA', type: 'http', critical: true, config: { url: 'https://x.test' } },
  { id: 2, label: 'Mapping', type: 'roundtrip', critical: true, config: {} },
  { id: 3, label: 'Routing', type: 'json', critical: true, config: {} },
  { id: 4, label: 'Measurement', type: 'manual', critical: false, config: {} }
];
const pass = { status: 'pass', ran_at: NOW - H };
const allPass = { 1: pass, 2: pass, 3: pass, 4: pass };
const approved = (over = {}) => ({ decision: 'approved', approver_id: 2, created_at: NOW - H, fingerprint: fingerprint(launch, checks), ...over });
const run = (over = {}) => evaluate({ launch, checks, latestRuns: allPass, approval: approved(), now: NOW, ...over });

test('all checks pass + valid approval → GO', () => {
  const r = run();
  assert.equal(r.status, STATUS.GO);
  assert.deepEqual(r.reasons, []);
});

test('R01: CTA works but a required CRM field is lost → BLOCKED, even with an approval', () => {
  const r = run({ latestRuns: { ...allPass, 2: { status: 'fail', ran_at: NOW - H } } });
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.reasons[0].code, 'CHECK_FAILED');
  assert.equal(r.reasons[0].label, 'Mapping');
});

test('unknown, never run and stale critical checks all block', () => {
  assert.equal(run({ latestRuns: { ...allPass, 1: { status: 'unknown', ran_at: NOW } } }).status, STATUS.BLOCKED);
  const { 3: _, ...missing } = allPass;
  assert.equal(run({ latestRuns: missing }).reasons[0].code, 'CHECK_NOT_RUN');
  assert.equal(run({ latestRuns: { ...allPass, 1: { status: 'pass', ran_at: NOW - 25 * H } } }).reasons[0].code, 'CHECK_STALE');
});

test('a launch without critical checks cannot be GO', () => {
  const r = evaluate({ launch, checks: [checks[3]], latestRuns: { 4: pass }, approval: null, now: NOW });
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.reasons[0].code, 'NO_CRITICAL_CHECKS');
});

test('missing approval → NEEDS_REVIEW, never GO', () => {
  const r = run({ approval: null });
  assert.equal(r.status, STATUS.REVIEW);
  assert.equal(r.approvalState, 'missing');
});

test('rejected approval → BLOCKED', () => {
  assert.equal(run({ approval: approved({ decision: 'rejected' }) }).status, STATUS.BLOCKED);
});

test('approval becomes stale when a check definition changes', () => {
  const changed = checks.map(c => (c.id === 2 ? { ...c, config: { new: true } } : c));
  const r = evaluate({ launch, checks: changed, latestRuns: allPass, approval: approved(), now: NOW });
  assert.equal(r.status, STATUS.REVIEW);
  assert.equal(r.approvalState, 'stale');
});

test('approval becomes stale when the scope changes, but not when checks are re-run', () => {
  assert.equal(evaluate({ launch: { ...launch, scope: 'Bigger' }, checks, latestRuns: allPass, approval: approved(), now: NOW }).approvalState, 'stale');
  assert.equal(run({ latestRuns: { 1: { status: 'pass', ran_at: NOW }, 2: pass, 3: pass, 4: pass } }).status, STATUS.GO);
});

test('four-eyes: owner approving their own launch does not count', () => {
  assert.equal(run({ approval: approved({ approver_id: 1 }) }).approvalState, 'self');
  assert.equal(run({ approval: approved({ approver_id: 1 }), settings: { fourEyes: false } }).status, STATUS.GO);
});

test('approval expires', () => {
  assert.equal(run({ approval: approved({ created_at: NOW - 15 * 24 * H }) }).approvalState, 'expired');
});

test('non-critical gap needs a documented, unexpired exception', () => {
  const gap = { ...allPass, 4: { status: 'fail', ran_at: NOW } };
  assert.equal(run({ latestRuns: gap }).status, STATUS.REVIEW);
  assert.equal(run({ latestRuns: gap, exceptions: [{ check_id: 4, expires_at: NOW + H }] }).status, STATUS.GO);
  assert.equal(run({ latestRuns: gap, exceptions: [{ check_id: 4, expires_at: NOW - 1 }] }).status, STATUS.REVIEW);
});

test('an exception on a critical check is ignored', () => {
  const r = run({ latestRuns: { ...allPass, 1: { status: 'fail', ran_at: NOW } }, exceptions: [{ check_id: 1, expires_at: NOW + H }] });
  assert.equal(r.status, STATUS.BLOCKED);
});

test('deterministic: same input gives the same output', () => {
  assert.deepEqual(run(), run());
  assert.equal(fingerprint(launch, [...checks].reverse()), fingerprint(launch, checks));
});

test('evaluate refuses to read the clock implicitly', () => {
  assert.throws(() => evaluate({ launch, checks, latestRuns: allPass }), /explicit `now`/);
});
