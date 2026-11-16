// Team configuration: branding, language, rule settings and reusable check templates.
// Loaded from signal.config.json (path via --config or SIGNAL_CONFIG). Everything is optional.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateCheck } from './checks/index.js';

export const DEFAULTS = Object.freeze({
  org: { name: 'Your team', productName: 'SIGNAL', accent: '#b9fa65', logoText: '' },
  language: 'en',
  rules: { maxCheckAgeHours: 24, approvalValidDays: 14, fourEyes: true, reviewDefaultDays: 3 },
  scheduler: { recheckMinutes: 0 },
  templates: []
});

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(path) {
  const file = path ? resolve(path) : null;
  let user = {};
  if (file && existsSync(file)) {
    try { user = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Could not parse ${file}: ${e.message}`); }
  }
  const cfg = merge(DEFAULTS, user);
  const problems = [];
  if (!['en', 'de'].includes(cfg.language)) problems.push('language must be "en" or "de"');
  if (!/^#[0-9a-f]{6}$/i.test(cfg.org.accent)) problems.push('org.accent must be a hex colour like #b9fa65');
  for (const n of ['maxCheckAgeHours', 'approvalValidDays', 'reviewDefaultDays']) {
    if (!(Number(cfg.rules[n]) > 0)) problems.push(`rules.${n} must be a positive number`);
  }
  if (!Array.isArray(cfg.templates)) problems.push('templates must be an array');
  else cfg.templates.forEach((t, i) => {
    if (!t.id || !t.name || !Array.isArray(t.checks)) problems.push(`templates[${i}] needs id, name and checks[]`);
    else t.checks.forEach((c, j) => validateCheck(c).forEach(e => problems.push(`templates[${i}].checks[${j}]: ${e}`)));
  });
  if (problems.length) throw new Error('Invalid configuration:\n  - ' + problems.join('\n  - '));
  return { ...cfg, file: file && existsSync(file) ? file : null };
}

/** The part of the configuration the browser may see. */
export function publicConfig(cfg) {
  return {
    org: cfg.org,
    language: cfg.language,
    rules: cfg.rules,
    templates: cfg.templates.map(t => ({ id: t.id, name: t.name, description: t.description ?? '', checks: t.checks.map(c => ({ label: c.label, type: c.type, critical: c.critical !== false })) }))
  };
}
