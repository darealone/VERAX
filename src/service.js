// Domain logic. Every state change is permission-checked, written in a transaction and audited.
// Free text (notes, reasons, evidence) is stored as data and never interpreted.
import { evaluate, fingerprint, STATUS } from './rules.js';
import { runCheck, validateCheck } from './checks/index.js';
import { hashPassword, verifyPassword, strip, can, newToken, sha } from './auth.js';

export class HttpError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}
const deny = () => { throw new HttpError(403, 'FORBIDDEN'); };
const notFound = () => { throw new HttpError(404, 'NOT_FOUND'); };
const bad = (code, detail) => { throw new HttpError(400, code, detail); };

const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const parseJson = s => { try { return JSON.parse(s); } catch { return {}; } };

export function createService(db, config, { clock = () => Date.now(), fetch: fetchImpl, sleep } = {}) {
  const settings = () => config.rules;

  // ---------- users ----------
  function needsSetup() { return !db.get('SELECT 1 AS x FROM users LIMIT 1'); }

  function createUser(actor, { email, name, role = 'member', password }) {
    const first = needsSetup();
    if (!first && !(actor && can.manageUsers(actor))) deny();
    email = str(email, 200).toLowerCase(); name = str(name, 120);
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) bad('INVALID_EMAIL');
    if (!name) bad('NAME_REQUIRED');
    if (!['admin', 'approver', 'member'].includes(role)) bad('INVALID_ROLE');
    if (first) role = 'admin';
    if (db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new HttpError(409, 'EMAIL_TAKEN');
    let pw;
    try { pw = hashPassword(password); } catch { bad('PASSWORD_TOO_SHORT'); }
    const now = clock();
    const { lastInsertRowid } = db.run('INSERT INTO users (email, name, role, pw_hash, created_at) VALUES (?,?,?,?,?)', email, name, role, pw, now);
    const id = Number(lastInsertRowid);
    db.audit('user.created', { actorId: actor?.id ?? id, data: { userId: id, email, role }, at: now });
    return strip(db.get('SELECT * FROM users WHERE id = ?', id));
  }

  function login(email, password) {
    const u = db.get('SELECT * FROM users WHERE email = ? AND disabled = 0', str(email, 200).toLowerCase());
    if (!u || !verifyPassword(password, u.pw_hash)) throw new HttpError(401, 'INVALID_LOGIN');
    db.audit('user.login', { actorId: u.id, at: clock() });
    return strip(u);
  }

  function listUsers(actor) {
    if (!actor) deny();
    return db.all('SELECT * FROM users ORDER BY name').map(strip);
  }

  function updateUser(actor, id, { role, disabled, password }) {
    if (!can.manageUsers(actor)) deny();
    const u = db.get('SELECT * FROM users WHERE id = ?', id) ?? notFound();
    if (role !== undefined) {
      if (!['admin', 'approver', 'member'].includes(role)) bad('INVALID_ROLE');
      if (u.role === 'admin' && role !== 'admin' && db.get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").n < 2) bad('LAST_ADMIN');
      db.run('UPDATE users SET role = ? WHERE id = ?', role, id);
    }
    if (disabled !== undefined) {
      if (id === actor.id) bad('CANNOT_DISABLE_SELF');
      db.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id);
      if (disabled) db.run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    if (password !== undefined) {
      try { db.run('UPDATE users SET pw_hash = ? WHERE id = ?', hashPassword(password), id); } catch { bad('PASSWORD_TOO_SHORT'); }
    }
    db.audit('user.updated', { actorId: actor.id, data: { userId: id, role, disabled, passwordChanged: password !== undefined }, at: clock() });
    return strip(db.get('SELECT * FROM users WHERE id = ?', id));
  }

  function changeOwnPassword(actor, { current, next }) {
    const u = db.get('SELECT * FROM users WHERE id = ?', actor.id);
    if (!verifyPassword(current, u.pw_hash)) throw new HttpError(401, 'INVALID_LOGIN');
    try { db.run('UPDATE users SET pw_hash = ? WHERE id = ?', hashPassword(next), actor.id); } catch { bad('PASSWORD_TOO_SHORT'); }
    db.audit('user.password_changed', { actorId: actor.id, at: clock() });
  }

  // ---------- API tokens (for CI pipelines) ----------
  function createToken(actor, name) {
    if (!actor) deny();
    const token = newToken('sig_');
    const { lastInsertRowid } = db.run('INSERT INTO api_tokens (name, token_hash, user_id, created_at) VALUES (?,?,?,?)', str(name, 80) || 'token', sha(token), actor.id, clock());
    db.audit('token.created', { actorId: actor.id, data: { tokenId: Number(lastInsertRowid), name }, at: clock() });
    return { id: Number(lastInsertRowid), token };
  }
  function listTokens(actor) { return db.all('SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC', actor.id); }
  function revokeToken(actor, id) {
    const r = db.run('DELETE FROM api_tokens WHERE id = ? AND (user_id = ? OR ? = 1)', id, actor.id, can.manageUsers(actor) ? 1 : 0);
    if (!r.changes) notFound();
    db.audit('token.revoked', { actorId: actor.id, data: { tokenId: id }, at: clock() });
  }

  // ---------- launches ----------
  const launchRow = id => db.get('SELECT * FROM launches WHERE id = ?', id) ?? notFound();
  const checkRow = id => db.get('SELECT * FROM checks WHERE id = ?', id) ?? notFound();
  const checksOf = launchId => db.all('SELECT * FROM checks WHERE launch_id = ? ORDER BY sort, id', launchId).map(c => ({ ...c, critical: !!c.critical, config: parseJson(c.config) }));
  const latestRun = checkId => db.get('SELECT * FROM runs WHERE check_id = ? ORDER BY ran_at DESC, id DESC LIMIT 1', checkId);
  const latestApproval = launchId => db.get('SELECT * FROM approvals WHERE launch_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', launchId);
  const activeExceptions = launchId => db.all('SELECT * FROM exceptions WHERE launch_id = ? AND revoked = 0', launchId);

  function evaluateLaunch(launchId) {
    const launch = launchRow(launchId);
    const checks = checksOf(launchId);
    const latestRuns = new Map(checks.map(c => [c.id, latestRun(c.id)]).filter(([, r]) => r));
    return evaluate({ launch, checks, latestRuns, exceptions: activeExceptions(launchId), approval: latestApproval(launchId) ?? null, now: clock(), settings: settings() });
  }

  /** Recompute and persist the status; audit only real transitions. */
  function recompute(launchId, actorId = null) {
    const before = launchRow(launchId).status;
    const ev = evaluateLaunch(launchId);
    if (ev.status !== before) {
      db.run('UPDATE launches SET status = ?, updated_at = ? WHERE id = ?', ev.status, clock(), launchId);
      db.audit('launch.status_changed', { actorId, launchId, data: { from: before, to: ev.status, rulesVersion: ev.rulesVersion, fingerprint: ev.fingerprint, reasons: ev.reasons.map(r => r.code) }, at: clock() });
    }
    return ev;
  }

  function insertCheck(launchId, def, sort) {
    const errors = validateCheck(def);
    if (errors.length) bad('INVALID_CHECK', errors);
    const { lastInsertRowid } = db.run('INSERT INTO checks (launch_id, label, type, critical, config, sort, created_at) VALUES (?,?,?,?,?,?,?)',
      launchId, str(def.label, 200), def.type, def.critical === false ? 0 : 1, JSON.stringify(def.config ?? {}), sort, clock());
    return Number(lastInsertRowid);
  }

  function createLaunch(actor, { name, scope, target_date, templateId, owner_id }) {
    if (!actor) deny();
    name = str(name, 160);
    if (!name) bad('NAME_REQUIRED');
    const owner = owner_id ? (db.get('SELECT id FROM users WHERE id = ? AND disabled = 0', owner_id) ?? bad('INVALID_OWNER')).id : actor.id;
    const tpl = templateId ? config.templates.find(t => t.id === templateId) ?? bad('UNKNOWN_TEMPLATE') : null;
    const now = clock();
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run('INSERT INTO launches (name, scope, owner_id, target_date, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        name, str(scope, 4000), owner, str(target_date, 20) || null, now, now);
      const lid = Number(lastInsertRowid);
      tpl?.checks.forEach((c, i) => insertCheck(lid, c, i));
      db.audit('launch.created', { actorId: actor.id, launchId: lid, data: { name, templateId: tpl?.id ?? null }, at: now });
      return lid;
    });
    recompute(id, actor.id);
    return getLaunch(actor, id);
  }

  function updateLaunch(actor, id, patch) {
    if (!actor) deny();
    const l = launchRow(id);
    const fields = {};
    if (patch.name !== undefined) fields.name = str(patch.name, 160) || bad('NAME_REQUIRED');
    if (patch.scope !== undefined) fields.scope = str(patch.scope, 4000);
    if (patch.target_date !== undefined) fields.target_date = str(patch.target_date, 20) || null;
    if (patch.archived !== undefined) fields.archived = patch.archived ? 1 : 0;
    if (patch.owner_id !== undefined) {
      if (actor.id !== l.owner_id && !can.manageUsers(actor)) deny();
      fields.owner_id = (db.get('SELECT id FROM users WHERE id = ? AND disabled = 0', patch.owner_id) ?? bad('INVALID_OWNER')).id;
    }
    const keys = Object.keys(fields);
    if (!keys.length) return getLaunch(actor, id);
    db.run(`UPDATE launches SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map(k => fields[k]), clock(), id);
    db.audit('launch.updated', { actorId: actor.id, launchId: id, data: fields, at: clock() });
    recompute(id, actor.id);
    return getLaunch(actor, id);
  }

  function listLaunches(actor, { archived = false } = {}) {
    if (!actor) deny();
    return db.all(`SELECT l.*, u.name AS owner_name,
        (SELECT COUNT(*) FROM checks c WHERE c.launch_id = l.id) AS check_count,
        (SELECT COUNT(*) FROM reviews r WHERE r.launch_id = l.id AND r.resolved_at IS NULL) AS open_reviews
      FROM launches l JOIN users u ON u.id = l.owner_id WHERE l.archived = ? ORDER BY l.updated_at DESC`, archived ? 1 : 0)
      .map(l => ({ ...l, evaluation: evaluateLaunch(l.id) }))
      .map(l => ({ ...l, status: l.evaluation.status }));
  }

  function getLaunch(actor, id) {
    if (!actor) deny();
    const launch = db.get('SELECT l.*, u.name AS owner_name FROM launches l JOIN users u ON u.id = l.owner_id WHERE l.id = ?', id) ?? notFound();
    const now = clock();
    const checks = checksOf(id).map(c => {
      const run = latestRun(c.id);
      return { ...c, latestRun: run ? { ...run, evidence: parseJson(run.evidence), ran_by_name: run.ran_by ? db.get('SELECT name FROM users WHERE id = ?', run.ran_by)?.name : null } : null };
    });
    const exceptions = db.all('SELECT e.*, u.name AS accepted_by_name FROM exceptions e JOIN users u ON u.id = e.accepted_by WHERE e.launch_id = ? AND e.revoked = 0 ORDER BY e.id DESC', id);
    const approvals = db.all('SELECT a.*, u.name AS approver_name FROM approvals a JOIN users u ON u.id = a.approver_id WHERE a.launch_id = ? ORDER BY a.created_at DESC, a.id DESC', id);
    const reviews = db.all('SELECT r.*, u.name AS assignee_name FROM reviews r JOIN users u ON u.id = r.assignee_id WHERE r.launch_id = ? ORDER BY r.resolved_at IS NOT NULL, r.due_at', id)
      .map(r => ({ ...r, overdue: !r.resolved_at && r.due_at < now }));
    return { launch, checks, exceptions, approvals, reviews, evaluation: recompute(id) };
  }

  // ---------- checks ----------
  function addCheck(actor, launchId, def) {
    if (!actor) deny();
    launchRow(launchId);
    const sort = (db.get('SELECT MAX(sort) AS m FROM checks WHERE launch_id = ?', launchId).m ?? -1) + 1;
    const id = insertCheck(launchId, def, sort);
    db.audit('check.added', { actorId: actor.id, launchId, data: { checkId: id, label: def.label, type: def.type, critical: def.critical !== false }, at: clock() });
    recompute(launchId, actor.id);
    return checkRow(id);
  }

  function updateCheck(actor, checkId, def) {
    if (!actor) deny();
    const c = checkRow(checkId);
    const merged = { label: def.label ?? c.label, type: def.type ?? c.type, critical: def.critical ?? !!c.critical, config: def.config ?? parseJson(c.config) };
    const errors = validateCheck(merged);
    if (errors.length) bad('INVALID_CHECK', errors);
    db.run('UPDATE checks SET label = ?, type = ?, critical = ?, config = ? WHERE id = ?', str(merged.label, 200), merged.type, merged.critical ? 1 : 0, JSON.stringify(merged.config), checkId);
    db.audit('check.updated', { actorId: actor.id, launchId: c.launch_id, data: { checkId, label: merged.label, type: merged.type, critical: merged.critical }, at: clock() });
    recompute(c.launch_id, actor.id);
    return checkRow(checkId);
  }

  function deleteCheck(actor, checkId) {
    if (!actor) deny();
    const c = checkRow(checkId);
    db.run('DELETE FROM checks WHERE id = ?', checkId);
    db.audit('check.deleted', { actorId: actor.id, launchId: c.launch_id, data: { checkId, label: c.label }, at: clock() });
    recompute(c.launch_id, actor.id);
  }

  function recordRun(check, result, actorId, attested = false) {
    const now = clock();
    db.run('INSERT INTO runs (check_id, launch_id, status, summary, evidence, ran_at, ran_by, duration_ms, attested) VALUES (?,?,?,?,?,?,?,?,?)',
      check.id, check.launch_id, result.status, str(result.summary, 1000), JSON.stringify(result.evidence ?? {}), now, actorId, result.durationMs ?? 0, attested ? 1 : 0);
    db.audit(attested ? 'check.attested' : 'check.ran', { actorId, launchId: check.launch_id, data: { checkId: check.id, status: result.status, summary: str(result.summary, 300) }, at: now });
  }

  /** Run all automated checks of a launch (or one). Manual checks are skipped: a person must attest them. */
  async function runChecks(actor, launchId, { checkId } = {}) {
    launchRow(launchId);
    const targets = checksOf(launchId).filter(c => c.type !== 'manual' && (!checkId || c.id === checkId));
    const results = await Promise.all(targets.map(async c => [c, await runCheck(c, { fetch: fetchImpl, sleep, now: clock() })]));
    for (const [c, r] of results) recordRun(c, r, actor?.id ?? null);
    return recompute(launchId, actor?.id ?? null);
  }

  function attest(actor, checkId, { status, note, link }) {
    if (!actor) deny();
    const c = checkRow(checkId);
    if (!['pass', 'fail'].includes(status)) bad('INVALID_STATUS');
    // An automated check can be reported as broken by a person, but only a real run can make it pass.
    if (c.type !== 'manual' && status === 'pass') bad('AUTOMATED_CHECK_NEEDS_RUN');
    note = str(note, 2000);
    if (!note) bad('EVIDENCE_REQUIRED');
    link = str(link, 500);
    if (link && !/^https?:\/\//.test(link)) bad('INVALID_LINK');
    recordRun(c, { status, summary: `${status === 'pass' ? 'Confirmed' : 'Reported as failing'} by ${actor.name}`, evidence: { note, link: link || null } }, actor.id, true);
    return recompute(c.launch_id, actor.id);
  }

  // ---------- documented exceptions (only for non-critical checks) ----------
  function acceptGap(actor, checkId, { reason, expiresDays = 14 }) {
    if (!can.approve(actor)) deny();
    const c = checkRow(checkId);
    if (c.critical) bad('CRITICAL_CHECK_CANNOT_BE_WAIVED');
    reason = str(reason, 2000);
    if (!reason) bad('REASON_REQUIRED');
    const days = Math.min(90, Math.max(1, Number(expiresDays) || 14));
    const now = clock();
    db.run('INSERT INTO exceptions (check_id, launch_id, reason, accepted_by, created_at, expires_at) VALUES (?,?,?,?,?,?)', checkId, c.launch_id, reason, actor.id, now, now + days * 864e5);
    db.audit('exception.accepted', { actorId: actor.id, launchId: c.launch_id, data: { checkId, reason, days }, at: now });
    return recompute(c.launch_id, actor.id);
  }

  function revokeException(actor, id) {
    if (!can.approve(actor)) deny();
    const e = db.get('SELECT * FROM exceptions WHERE id = ?', id) ?? notFound();
    db.run('UPDATE exceptions SET revoked = 1 WHERE id = ?', id);
    db.audit('exception.revoked', { actorId: actor.id, launchId: e.launch_id, data: { exceptionId: id }, at: clock() });
    return recompute(e.launch_id, actor.id);
  }

  // ---------- approvals ----------
  function decide(actor, launchId, { decision, note }) {
    if (!can.approve(actor)) deny();
    const launch = launchRow(launchId);
    if (!['approved', 'rejected'].includes(decision)) bad('INVALID_DECISION');
    if (settings().fourEyes && launch.owner_id === actor.id) bad('FOUR_EYES', 'The launch owner cannot approve their own launch.');
    const ev = evaluateLaunch(launchId);
    if (decision === 'approved' && ev.reasons.some(r => r.level === 'block')) bad('CANNOT_APPROVE_BLOCKED', 'Fix blocking checks first. A blocker cannot be approved away.');
    const fp = fingerprint(launch, checksOf(launchId));
    const now = clock();
    db.run('INSERT INTO approvals (launch_id, approver_id, decision, fingerprint, note, created_at) VALUES (?,?,?,?,?,?)', launchId, actor.id, decision, fp, str(note, 2000), now);
    db.audit(`approval.${decision}`, { actorId: actor.id, launchId, data: { fingerprint: fp, note: str(note, 300) }, at: now });
    return recompute(launchId, actor.id);
  }

  // ---------- reviews: a named person, a concrete point, a deadline ----------
  function assignReview(actor, launchId, { assignee_id, due_at, note }) {
    if (!actor) deny();
    launchRow(launchId);
    const assignee = db.get('SELECT id FROM users WHERE id = ? AND disabled = 0', assignee_id) ?? bad('INVALID_ASSIGNEE');
    note = str(note, 2000);
    if (!note) bad('NOTE_REQUIRED');
    const now = clock();
    const due = Number(due_at) || now + config.rules.reviewDefaultDays * 864e5;
    if (due <= now) bad('DUE_IN_PAST');
    const { lastInsertRowid } = db.run('INSERT INTO reviews (launch_id, assignee_id, due_at, note, created_by, created_at) VALUES (?,?,?,?,?,?)', launchId, assignee.id, due, note, actor.id, now);
    db.audit('review.assigned', { actorId: actor.id, launchId, data: { reviewId: Number(lastInsertRowid), assigneeId: assignee.id, due }, at: now });
    return getLaunch(actor, launchId);
  }

  function resolveReview(actor, id) {
    if (!actor) deny();
    const r = db.get('SELECT * FROM reviews WHERE id = ?', id) ?? notFound();
    if (r.assignee_id !== actor.id && !can.approve(actor)) deny();
    db.run('UPDATE reviews SET resolved_at = ? WHERE id = ?', clock(), id);
    db.audit('review.resolved', { actorId: actor.id, launchId: r.launch_id, data: { reviewId: id }, at: clock() });
    return getLaunch(actor, r.launch_id);
  }

  // ---------- audit ----------
  function auditLog(actor, { launchId, limit = 200 } = {}) {
    if (!actor) deny();
    const rows = launchId
      ? db.all('SELECT a.*, u.name AS actor_name FROM audit a LEFT JOIN users u ON u.id = a.actor_id WHERE a.launch_id = ? ORDER BY a.id DESC LIMIT ?', launchId, limit)
      : db.all('SELECT a.*, u.name AS actor_name FROM audit a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?', Math.min(1000, limit));
    return { entries: rows.map(r => ({ ...r, data: parseJson(r.data) })), integrity: db.verifyAudit() };
  }

  /** Re-run automated checks of every active launch (used by the optional scheduler). */
  async function recheckAll() {
    const ids = db.all('SELECT id FROM launches WHERE archived = 0').map(r => r.id);
    for (const id of ids) await runChecks(null, id);
    return ids.length;
  }

  return {
    needsSetup, createUser, login, listUsers, updateUser, changeOwnPassword,
    createToken, listTokens, revokeToken,
    createLaunch, updateLaunch, listLaunches, getLaunch, evaluateLaunch,
    addCheck, updateCheck, deleteCheck, runChecks, attest,
    acceptGap, revokeException, decide, assignReview, resolveReview,
    auditLog, recheckAll, STATUS
  };
}
