#!/usr/bin/env node
// VERAX MERIDIAN command line: run the server, scaffold a config, or gate a CI pipeline on a launch status.

// node:sqlite is stable enough for this use but still prints an experimental warning; hide only that one.
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));

const { existsSync, copyFileSync, readFileSync } = await import('node:fs');
const { join, dirname, resolve } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const HELP = `VERAX MERIDIAN ${pkg.version} — launch readiness gate

Usage:
  verax serve [--port 8080] [--host 127.0.0.1] [--data ./data/verax.db]
               [--config ./verax.config.json] [--secure-cookies] [--demo]
  verax init                       write verax.config.json (example) into this folder
  verax status <launchId>          print status; exit 0 = GO, 1 = BLOCKED, 2 = NEEDS_REVIEW
  verax run <launchId>             run automated checks, then behave like "status"
  verax verify-audit [--data ...]  check the audit log hash chain
  verax --version

Environment:
  PORT, HOST, VERAX_DATA, VERAX_CONFIG, VERAX_SECURE_COOKIES=1
  VERAX_URL, VERAX_TOKEN          for "status" and "run" (create a token under Settings)
`;

const a = args(process.argv.slice(2));
const cmd = a._[0] ?? (a.version ? 'version' : 'help');

if (cmd === 'version' || a.version) { console.log(pkg.version); process.exit(0); }
if (cmd === 'help' || a.help) { console.log(HELP); process.exit(0); }

if (cmd === 'init') {
  const target = resolve('verax.config.json');
  if (existsSync(target)) { console.error(`${target} already exists, not overwriting.`); process.exit(1); }
  copyFileSync(join(ROOT, 'examples', 'verax.config.example.json'), target);
  console.log(`Wrote ${target}\nEdit it, then run: verax serve --config verax.config.json`);
  process.exit(0);
}

if (cmd === 'serve') {
  const { loadConfig } = await import('../src/config.js');
  const { createApp } = await import('../src/server.js');
  const demo = !!a.demo;
  const port = Number(a.port ?? process.env.PORT ?? 8080);
  const host = a.host ?? process.env.HOST ?? '127.0.0.1';
  const dbFile = resolve(a.data ?? process.env.VERAX_DATA ?? (demo ? './data/demo.db' : './data/verax.db'));
  let config;
  try { config = loadConfig(a.config ?? process.env.VERAX_CONFIG ?? (existsSync('verax.config.json') ? 'verax.config.json' : null)); }
  catch (e) { console.error(e.message); process.exit(1); }
  const secureCookies = !!a['secure-cookies'] || process.env.VERAX_SECURE_COOKIES === '1';
  const { server, svc } = createApp({ config, dbFile, demo, secureCookies });
  server.listen(port, host, async () => {
    const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
    if (demo && svc.needsSetup()) await seedDemo(svc, base);
    console.log(`VERAX MERIDIAN ${pkg.version} running on ${base}`);
    console.log(`  data:   ${dbFile}`);
    console.log(`  config: ${config.file ?? '(defaults)'}`);
    if (svc.needsSetup()) console.log('  First start: open the URL above to create the admin account.');
    if (demo) console.log('  DEMO MODE: sample users and a sample launch. Do not use demo data in production.');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} else if (cmd === 'status' || cmd === 'run') {
  const id = Number(a._[1]);
  const base = (a.url ?? process.env.VERAX_URL ?? '').replace(/\/$/, '');
  const token = a.token ?? process.env.VERAX_TOKEN;
  if (!id || !base || !token) { console.error('Need a launch id, VERAX_URL and VERAX_TOKEN.'); process.exit(3); }
  const call = async (path, method = 'GET') => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`HTTP ${r.status}: ${body.error ?? 'error'}`); process.exit(3); }
    return body;
  };
  try {
    if (cmd === 'run') await call(`/api/launches/${id}/run`, 'POST');
    const s = await call(`/api/launches/${id}/status`);
    console.log(`Launch ${id}: ${s.status}  (rules ${s.rulesVersion}, fingerprint ${s.fingerprint})`);
    for (const r of s.reasons) console.log(`  [${r.level}] ${r.code}${r.label ? ' — ' + r.label : ''}`);
    process.exit(s.status === 'GO' ? 0 : s.status === 'BLOCKED' ? 1 : 2);
  } catch (e) { console.error(`Could not reach ${base}: ${e.message}`); process.exit(3); }
} else if (cmd === 'verify-audit') {
  const { openDb } = await import('../src/db.js');
  const db = openDb(resolve(a.data ?? process.env.VERAX_DATA ?? './data/verax.db'));
  const r = db.verifyAudit();
  console.log(r.ok ? 'Audit log intact.' : `Audit log broken at entry ${r.brokenAt}.`);
  process.exit(r.ok ? 0 : 1);
} else {
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  process.exit(3);
}

async function seedDemo(svc, base) {
  const { demoChecks } = await import('../src/demo.js');
  const pw = 'demo-password-123';
  const admin = svc.createUser(null, { email: 'alex@example.test', name: 'Alex Admin', password: pw });
  const approver = svc.createUser(admin, { email: 'sam@example.test', name: 'Sam Approver', role: 'approver', password: pw });
  svc.createUser(admin, { email: 'kim@example.test', name: 'Kim Member', role: 'member', password: pw });
  const launch = svc.createLaunch(admin, { name: 'Autumn webinar campaign', scope: 'Paid social + email → webinar registration → CRM → inbound sales', target_date: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) });
  for (const c of demoChecks(base)) svc.addCheck(admin, launch.launch.id, c);
  await svc.runChecks(admin, launch.launch.id);
  console.log(`  Demo logins (password "${pw}"): alex@example.test (admin), sam@example.test (approver), kim@example.test (member)`);
  return approver;
}
