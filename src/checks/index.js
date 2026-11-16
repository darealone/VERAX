// Check runners. Each one is a named, bounded tool: fixed purpose, fixed parameters,
// read-mostly, and it returns structured evidence. Any error becomes `unknown`, never `pass`.

import { randomUUID } from 'node:crypto';

export const CHECK_TYPES = ['http', 'json', 'roundtrip', 'manual'];

const MAX_BODY = 512 * 1024;

/** Replace ${ENV:NAME} with process.env.NAME at run time. Secrets never live in the database. */
export function resolveEnv(value, env = process.env) {
  if (typeof value === 'string') {
    return value.replace(/\$\{ENV:([A-Z0-9_]+)\}/g, (_, name) => {
      if (env[name] === undefined) throw new Error(`Environment variable ${name} is not set`);
      return env[name];
    });
  }
  if (Array.isArray(value)) return value.map(v => resolveEnv(v, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnv(v, env)]));
  return value;
}

/** Replace {{var}} placeholders (used for the synthetic test id). */
export function fill(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(value)) return value.map(v => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

/** Minimal path lookup: "data.items[0].email" */
export function getPath(obj, path) {
  if (!path) return obj;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function assertUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`Invalid URL: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http(s) URLs are allowed: ${raw}`);
  return u;
}

async function request({ url, method = 'GET', headers = {}, body, timeoutMs = 10_000 }, fetchImpl) {
  assertUrl(url);
  const init = { method, headers: { 'user-agent': 'verax-meridian/0.1', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    if (typeof body === 'string') init.body = body;
    else { init.body = JSON.stringify(body); init.headers['content-type'] ??= 'application/json'; }
  }
  const t0 = Date.now();
  const res = await fetchImpl(url, init);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf.byteLength > MAX_BODY ? buf.slice(0, MAX_BODY) : buf);
  return { status: res.status, finalUrl: res.url || url, text, ms: Date.now() - t0 };
}

function statusOk(code, expect) {
  if (Array.isArray(expect)) return expect.includes(code);
  if (typeof expect === 'number') return code === expect;
  return code >= 200 && code < 400;
}

function compareExpectations(json, expect, vars) {
  const failures = [];
  for (const [path, wanted] of Object.entries(fill(expect ?? {}, vars))) {
    const actual = getPath(json, path);
    const ok = wanted === '*' ? actual !== undefined && actual !== null && actual !== '' : String(actual) === String(wanted);
    if (!ok) failures.push({ path, expected: wanted === '*' ? '(any non-empty value)' : wanted, actual: actual === undefined ? '(missing)' : actual });
  }
  return failures;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { throw new Error('Response is not valid JSON'); }
}

const runners = {
  // Is the page reachable, and does it land where it should?
  async http(cfg, ctx) {
    const r = await request(resolveEnv({ url: cfg.url, method: cfg.method, headers: cfg.headers, timeoutMs: cfg.timeoutMs }), ctx.fetch);
    const problems = [];
    if (!statusOk(r.status, cfg.expectStatus)) problems.push(`HTTP ${r.status}`);
    if (cfg.expectFinalUrlContains && !r.finalUrl.includes(cfg.expectFinalUrlContains)) problems.push(`landed on ${r.finalUrl}`);
    if (cfg.expectBodyContains && !r.text.includes(cfg.expectBodyContains)) problems.push(`page does not contain "${cfg.expectBodyContains}"`);
    return {
      status: problems.length ? 'fail' : 'pass',
      summary: problems.length ? problems.join('; ') : `HTTP ${r.status} in ${r.ms} ms`,
      evidence: { httpStatus: r.status, finalUrl: r.finalUrl, ms: r.ms }
    };
  },

  // Does an API return the expected values? (e.g. a routing rule, a field definition)
  async json(cfg, ctx) {
    const r = await request(resolveEnv({ url: cfg.url, method: cfg.method, headers: cfg.headers, body: cfg.body, timeoutMs: cfg.timeoutMs }), ctx.fetch);
    if (!statusOk(r.status, cfg.expectStatus)) return { status: 'fail', summary: `HTTP ${r.status}`, evidence: { httpStatus: r.status } };
    const failures = compareExpectations(parseJson(r.text), cfg.expect, {});
    return {
      status: failures.length ? 'fail' : 'pass',
      summary: failures.length ? `${failures.length} expectation(s) not met` : 'All expectations met',
      evidence: { httpStatus: r.status, failures, ms: r.ms }
    };
  },

  // Synthetic record end to end: submit a test record, then read it back and compare fields.
  async roundtrip(cfg, ctx) {
    const vars = { testId: ctx.testId, now: new Date(ctx.now).toISOString() };
    const submit = resolveEnv(fill(cfg.submit ?? {}, vars));
    const s = await request(submit, ctx.fetch);
    if (!statusOk(s.status, submit.expectStatus)) {
      return { status: 'fail', summary: `Submit step returned HTTP ${s.status}`, evidence: { testId: ctx.testId, submitStatus: s.status } };
    }
    const verify = resolveEnv(fill(cfg.verify ?? {}, vars));
    const tries = Math.max(1, Math.min(10, verify.retries ?? 3));
    let last;
    for (let i = 0; i < tries; i++) {
      await ctx.sleep(verify.waitMs ?? 2000);
      const v = await request(verify, ctx.fetch);
      if (v.status === 404) { last = { status: 'fail', summary: 'Test record not found after submit', evidence: { testId: ctx.testId, verifyStatus: 404 } }; continue; }
      if (!statusOk(v.status, verify.expectStatus)) { last = { status: 'unknown', summary: `Verify step returned HTTP ${v.status}`, evidence: { testId: ctx.testId, verifyStatus: v.status } }; continue; }
      const failures = compareExpectations(parseJson(v.text), cfg.expect, vars);
      last = {
        status: failures.length ? 'fail' : 'pass',
        summary: failures.length ? `${failures.length} field(s) missing or wrong in target system` : 'Test record arrived with all expected fields',
        evidence: { testId: ctx.testId, attempts: i + 1, failures }
      };
      if (!failures.length) break;
    }
    return last;
  },

  // Some things can only be confirmed by a person. The attestation is recorded via the API, not here.
  async manual() {
    return { status: 'unknown', summary: 'Needs a named person to confirm with evidence', evidence: {} };
  }
};

/**
 * Run one check. Never throws: errors become status `unknown` with the error message as evidence.
 */
export async function runCheck(check, { fetch: fetchImpl = globalThis.fetch, now = Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), testId } = {}) {
  const runner = runners[check.type];
  const t0 = Date.now();
  const ctx = { fetch: fetchImpl, now, sleep, testId: testId ?? `verax-test-${randomUUID().slice(0, 8)}` };
  if (!runner) return { status: 'unknown', summary: `Unknown check type "${check.type}"`, evidence: {}, durationMs: 0 };
  try {
    const out = await runner(check.config ?? {}, ctx);
    return { ...out, durationMs: Date.now() - t0 };
  } catch (err) {
    const msg = err?.name === 'TimeoutError' ? 'Timed out' : (err?.message || String(err));
    return { status: 'unknown', summary: `Could not verify: ${msg}`, evidence: { error: msg }, durationMs: Date.now() - t0 };
  }
}

/** Basic validation for check definitions coming from the UI or the config file. */
export function validateCheck(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return ['Check must be an object'];
  if (!def.label || typeof def.label !== 'string' || def.label.length > 200) errors.push('label is required (max 200 chars)');
  if (!CHECK_TYPES.includes(def.type)) errors.push(`type must be one of ${CHECK_TYPES.join(', ')}`);
  const c = def.config ?? {};
  const url = v => typeof v === 'string' && /^(https?:\/\/|\$\{ENV:)/.test(v);
  if (def.type === 'http' && !url(c.url)) errors.push('config.url must be an http(s) URL');
  if (def.type === 'json' && !url(c.url)) errors.push('config.url must be an http(s) URL');
  if (def.type === 'roundtrip') {
    if (!url(c.submit?.url)) errors.push('config.submit.url must be an http(s) URL');
    if (!url(c.verify?.url)) errors.push('config.verify.url must be an http(s) URL');
    if (!c.expect || typeof c.expect !== 'object') errors.push('config.expect must map field paths to expected values');
  }
  return errors;
}
