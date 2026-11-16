// HTTP server: JSON API + static web UI. Zero dependencies.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createService, HttpError } from './service.js';
import { publicConfig } from './config.js';
import { userFromRequest, createSession, sessionCookie, sha } from './auth.js';
import { RULES_VERSION } from './rules.js';
import { mountDemo } from './demo.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY'
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...(isJson ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req, limit = 256 * 1024) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return {};
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'BODY_TOO_LARGE'); chunks.push(c); }
  if (!size) return {};
  // Requiring JSON blocks cross-site form posts (CSRF) in addition to SameSite=Strict cookies.
  if (!String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'JSON_REQUIRED');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'INVALID_JSON'); }
}

function rateLimiter(max, windowMs) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter(t => now - t < windowMs);
    list.push(now); hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return list.length <= max;
  };
}

/** Tiny router: [method, /path/:param, handler] */
function router(routes) {
  const compiled = routes.map(([m, p, h]) => [m, new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h]);
  return (method, path) => {
    for (const [m, re, h] of compiled) {
      const match = method === m && re.exec(path);
      if (match) return { handler: h, params: match.groups ?? {} };
    }
    return null;
  };
}

export function createApp({ config, dbFile, demo = false, secureCookies = false, clock, fetch: fetchImpl, sleep } = {}) {
  const db = openDb(dbFile);
  const svc = createService(db, config, { clock, fetch: fetchImpl, sleep });
  const loginLimit = rateLimiter(10, 60_000);
  const demoRoutes = demo ? mountDemo() : null;

  const need = u => { if (!u) throw new HttpError(401, 'LOGIN_REQUIRED'); return u; };
  const id = v => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'INVALID_ID'); return n; };

  const route = router([
    ['GET', '/api/health', () => ({ ok: true, rulesVersion: RULES_VERSION })],
    ['GET', '/api/config', () => ({ ...publicConfig(config), needsSetup: svc.needsSetup(), rulesVersion: RULES_VERSION, demo })],
    ['POST', '/api/setup', ({ body, res }) => {
      if (!svc.needsSetup()) throw new HttpError(409, 'ALREADY_SET_UP');
      const user = svc.createUser(null, { ...body, role: 'admin' });
      res.setHeader('set-cookie', sessionCookie(createSession(db, user.id), { secure: secureCookies }));
      return { user };
    }],
    ['POST', '/api/login', ({ body, res, req }) => {
      if (!loginLimit(req.socket.remoteAddress ?? 'x')) throw new HttpError(429, 'TOO_MANY_ATTEMPTS');
      const user = svc.login(body.email, body.password);
      res.setHeader('set-cookie', sessionCookie(createSession(db, user.id), { secure: secureCookies }));
      return { user };
    }],
    ['POST', '/api/logout', ({ user, res }) => {
      if (user?.sessionToken) db.run('DELETE FROM sessions WHERE token_hash = ?', sha(user.sessionToken));
      res.setHeader('set-cookie', sessionCookie('', { clear: true, secure: secureCookies }));
      return { ok: true };
    }],
    ['GET', '/api/me', ({ user }) => ({ user: need(user) && { id: user.id, email: user.email, name: user.name, role: user.role } })],
    ['POST', '/api/me/password', ({ user, body }) => { svc.changeOwnPassword(need(user), body); return { ok: true }; }],
    ['GET', '/api/users', ({ user }) => svc.listUsers(need(user))],
    ['POST', '/api/users', ({ user, body }) => svc.createUser(need(user), body)],
    ['PATCH', '/api/users/:id', ({ user, body, params }) => svc.updateUser(need(user), id(params.id), body)],
    ['GET', '/api/tokens', ({ user }) => svc.listTokens(need(user))],
    ['POST', '/api/tokens', ({ user, body }) => svc.createToken(need(user), body.name)],
    ['DELETE', '/api/tokens/:id', ({ user, params }) => { svc.revokeToken(need(user), id(params.id)); return { ok: true }; }],
    ['GET', '/api/launches', ({ user, url }) => svc.listLaunches(need(user), { archived: url.searchParams.get('archived') === '1' })],
    ['POST', '/api/launches', ({ user, body }) => svc.createLaunch(need(user), body)],
    ['GET', '/api/launches/:id', ({ user, params }) => svc.getLaunch(need(user), id(params.id))],
    ['PATCH', '/api/launches/:id', ({ user, params, body }) => svc.updateLaunch(need(user), id(params.id), body)],
    ['GET', '/api/launches/:id/status', ({ user, params }) => { need(user); const e = svc.evaluateLaunch(id(params.id)); return { status: e.status, reasons: e.reasons, rulesVersion: e.rulesVersion, fingerprint: e.fingerprint }; }],
    ['POST', '/api/launches/:id/checks', ({ user, params, body }) => svc.addCheck(need(user), id(params.id), body)],
    ['POST', '/api/launches/:id/run', ({ user, params }) => svc.runChecks(need(user), id(params.id))],
    ['POST', '/api/launches/:id/decision', ({ user, params, body }) => svc.decide(need(user), id(params.id), body)],
    ['POST', '/api/launches/:id/reviews', ({ user, params, body }) => svc.assignReview(need(user), id(params.id), body)],
    ['GET', '/api/launches/:id/audit', ({ user, params }) => svc.auditLog(need(user), { launchId: id(params.id) })],
    ['PATCH', '/api/checks/:id', ({ user, params, body }) => svc.updateCheck(need(user), id(params.id), body)],
    ['DELETE', '/api/checks/:id', ({ user, params }) => { svc.deleteCheck(need(user), id(params.id)); return { ok: true }; }],
    ['POST', '/api/checks/:id/run', ({ user, params }) => { const c = db.get('SELECT launch_id FROM checks WHERE id = ?', id(params.id)); if (!c) throw new HttpError(404, 'NOT_FOUND'); return svc.runChecks(need(user), c.launch_id, { checkId: id(params.id) }); }],
    ['POST', '/api/checks/:id/attest', ({ user, params, body }) => svc.attest(need(user), id(params.id), body)],
    ['POST', '/api/checks/:id/exceptions', ({ user, params, body }) => svc.acceptGap(need(user), id(params.id), body)],
    ['DELETE', '/api/exceptions/:id', ({ user, params }) => svc.revokeException(need(user), id(params.id))],
    ['POST', '/api/reviews/:id/resolve', ({ user, params }) => svc.resolveReview(need(user), id(params.id))],
    ['GET', '/api/audit', ({ user }) => svc.auditLog(need(user))]
  ]);

  async function serveStatic(path, res) {
    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    try {
      const data = await readFile(file);
      send(res, 200, data, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    } catch {
      // SPA fallback for client-side routes like /launch/3
      if (!extname(rel)) return send(res, 200, await readFile(join(PUBLIC, 'index.html')), { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
      send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (demoRoutes && url.pathname.startsWith('/demo/')) return await demoRoutes(req, res, url);
      if (!url.pathname.startsWith('/api/')) return await serveStatic(url.pathname, res);
      const match = route(req.method, url.pathname);
      if (!match) throw new HttpError(404, 'NOT_FOUND');
      const body = await readJson(req);
      const user = userFromRequest(db, req);
      const out = await match.handler({ req, res, url, body, user, params: match.params });
      send(res, 200, out ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, detail: err.detail ?? null });
      console.error(err);
      send(res, 500, { error: 'INTERNAL_ERROR' });
    }
  });

  let timer = null;
  if (config.scheduler?.recheckMinutes > 0) {
    timer = setInterval(() => svc.recheckAll().catch(e => console.error('Scheduled recheck failed:', e.message)), config.scheduler.recheckMinutes * 60_000);
    timer.unref();
  }
  server.on('close', () => { clearInterval(timer); db.close(); });
  return { server, db, svc };
}
