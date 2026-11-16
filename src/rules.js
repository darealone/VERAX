// Deterministic launch readiness rules.
// Same input + same RULES_VERSION = same result. No network, no clock reads, no randomness:
// the caller passes `now` explicitly so evaluations can be replayed from the audit log.

import { createHash } from 'node:crypto';

export const RULES_VERSION = '2026.1';

export const STATUS = Object.freeze({ GO: 'GO', BLOCKED: 'BLOCKED', REVIEW: 'NEEDS_REVIEW' });

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Stable JSON: object keys sorted, so the fingerprint does not depend on key order. */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

/**
 * The fingerprint identifies "what exactly was approved": the launch scope and every check definition.
 * Re-running checks does not change it. Editing a check, adding one or changing the scope does,
 * which makes earlier approvals stale.
 */
export function fingerprint(launch, checks) {
  const scope = { name: launch.name, scope: launch.scope ?? '', target: launch.target_date ?? null };
  const defs = [...checks]
    .sort((a, b) => a.id - b.id)
    .map(c => ({ id: c.id, label: c.label ?? '', type: c.type, critical: !!c.critical, config: c.config ?? {} }));
  return createHash('sha256').update(canonical({ scope, defs, rules: RULES_VERSION })).digest('hex').slice(0, 16);
}

/**
 * @param {object} input
 * @param {object} input.launch            { id, name, owner_id, ... }
 * @param {object[]} input.checks          [{ id, label, critical, ... }]
 * @param {Map|object} input.latestRuns    checkId -> { status: 'pass'|'fail'|'unknown', ran_at }
 * @param {object[]} input.exceptions      [{ check_id, expires_at }]  (accepted, documented gaps)
 * @param {object|null} input.approval     latest decision { decision: 'approved'|'rejected', fingerprint, created_at, approver_id }
 * @param {number} input.now               epoch ms
 * @param {object} [input.settings]        { maxCheckAgeHours, approvalValidDays, fourEyes }
 */
export function evaluate({ launch, checks, latestRuns, exceptions = [], approval = null, now, settings = {} }) {
  if (typeof now !== 'number') throw new TypeError('evaluate() needs an explicit `now` (epoch ms)');
  const cfg = { maxCheckAgeHours: 24, approvalValidDays: 14, fourEyes: true, ...settings };
  const runs = latestRuns instanceof Map ? latestRuns : new Map(Object.entries(latestRuns ?? {}).map(([k, v]) => [Number(k), v]));
  const fp = fingerprint(launch, checks);
  const reasons = [];

  const runState = check => {
    const run = runs.get(check.id);
    if (!run) return 'not_run';
    if (now - run.ran_at > cfg.maxCheckAgeHours * HOUR) return 'stale';
    return run.status === 'pass' ? 'pass' : run.status === 'fail' ? 'fail' : 'unknown';
  };
  const code = { fail: 'CHECK_FAILED', unknown: 'CHECK_UNKNOWN', not_run: 'CHECK_NOT_RUN', stale: 'CHECK_STALE' };

  // 1. Critical checks. Anything other than a fresh pass blocks. Reviews cannot override this.
  const critical = checks.filter(c => c.critical);
  if (critical.length === 0) reasons.push({ level: 'block', code: 'NO_CRITICAL_CHECKS' });
  for (const c of critical) {
    const s = runState(c);
    if (s !== 'pass') reasons.push({ level: 'block', code: code[s], checkId: c.id, label: c.label });
  }

  // 2. Approval record.
  let approvalState = 'missing';
  if (approval) {
    const expired = now - approval.created_at > cfg.approvalValidDays * DAY;
    const self = cfg.fourEyes && approval.approver_id === launch.owner_id;
    if (approval.fingerprint !== fp) approvalState = 'stale';
    else if (self) approvalState = 'self';
    else if (approval.decision === 'rejected') approvalState = 'rejected';
    else if (expired) approvalState = 'expired';
    else approvalState = 'valid';
  }
  if (approvalState === 'rejected') reasons.push({ level: 'block', code: 'APPROVAL_REJECTED' });

  // 3. Non-critical checks: an open gap needs a documented, unexpired exception.
  for (const c of checks.filter(c => !c.critical)) {
    const s = runState(c);
    if (s === 'pass') continue;
    const ex = exceptions.find(e => e.check_id === c.id && (!e.expires_at || e.expires_at > now));
    if (ex) reasons.push({ level: 'info', code: 'GAP_ACCEPTED', checkId: c.id, label: c.label });
    else reasons.push({ level: 'review', code: 'GAP_OPEN', checkId: c.id, label: c.label, state: s });
  }

  // 4. Without a valid approval for exactly this fingerprint there is no GO.
  const approvalCode = { missing: 'APPROVAL_MISSING', stale: 'APPROVAL_STALE', expired: 'APPROVAL_EXPIRED', self: 'APPROVAL_SELF' };
  if (approvalCode[approvalState]) reasons.push({ level: 'review', code: approvalCode[approvalState] });

  const status = reasons.some(r => r.level === 'block') ? STATUS.BLOCKED
    : reasons.some(r => r.level === 'review') ? STATUS.REVIEW
    : STATUS.GO;

  return { status, reasons, fingerprint: fp, rulesVersion: RULES_VERSION, approvalState, evaluatedAt: now };
}
