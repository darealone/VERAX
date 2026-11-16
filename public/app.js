// VERAX MERIDIAN web UI. Plain DOM, no framework, no build step.
// All user-provided text is inserted with textContent (never innerHTML).
import { t, setLang, getLang, fmtDate } from './i18n.js';

const $ = sel => document.querySelector(sel);
const main = $('#main');
const S = { config: null, me: null, users: [] };

// ---------- helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'ERROR'); e.code = data.error; e.detail = data.detail; e.status = r.status; throw e; }
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const el = $('#toast'); el.textContent = msg; el.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 3800);
}
function fail(e) {
  if (e.status === 401 && e.code === 'LOGIN_REQUIRED') { S.me = null; return render(); }
  const key = 'e_' + e.code; const msg = t(key) !== key ? t(key) : t('error') + (e.code ? ` (${e.code})` : '');
  toast(Array.isArray(e.detail) ? msg + ' ' + e.detail.join('; ') : msg, true);
}
async function act(btn, fn) {
  const label = btn?.textContent; if (btn) { btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin' }), ' ', label); }
  try { return await fn(); } catch (e) { fail(e); } finally { if (btn?.isConnected) { btn.disabled = false; btn.textContent = label; } }
}
const formData = form => Object.fromEntries(new FormData(form).entries());
const badge = status => h('span', { class: `badge s-${status}`, text: t('st_' + status) });
const initials = name => (name.trim().split(/\s+/).length > 1 ? name.trim().split(/\s+/).map(w => w[0]).join('') : name.slice(0, 2)).slice(0, 3).toUpperCase();
const canApprove = () => S.me && (S.me.role === 'admin' || S.me.role === 'approver');

// ---------- shell ----------
function applyBranding() {
  const { org } = S.config;
  document.documentElement.style.setProperty('--accent', org.accent);
  $('#product').textContent = org.productName; $('#org').textContent = org.name;
  $('#logo').textContent = org.logoText || initials(org.productName);
  document.title = org.productName;
}
function shell() {
  $('#top').hidden = !S.me;
  if (!S.me) return;
  const route = location.hash.split('/')[1] || '';
  $('#nav').replaceChildren(...[['', 'nav_launches'], ['audit', 'nav_audit'], ['settings', 'nav_settings']].map(([r, k]) =>
    h('a', { href: '#/' + r, 'aria-current': (route === r || (r === '' && route === 'launch')) ? 'page' : false, text: t(k) })));
  $('#who').textContent = `${S.me.name} · ${t('role_' + S.me.role)}`;
  $('#logout').textContent = t('logout');
}
$('#lang').addEventListener('click', () => { setLang(getLang() === 'en' ? 'de' : 'en'); try { localStorage.setItem('verax.lang', getLang()); } catch {} render(); });
$('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); S.me = null; location.hash = '#/'; render(); });
window.addEventListener('hashchange', () => render());

async function render() {
  $('#lang').textContent = getLang() === 'en' ? 'DE' : 'EN';
  if (S.config.needsSetup) { shell(); return viewSetup(); }
  if (!S.me) { shell(); return viewLogin(); }
  shell();
  const [, route, id] = location.hash.split('/');
  try {
    if (route === 'launch' && id) await viewLaunch(Number(id));
    else if (route === 'audit') await viewAudit();
    else if (route === 'settings') await viewSettings();
    else await viewLaunches();
  } catch (e) { fail(e); }
}

// ---------- auth views ----------
function authCard(title, sub, fields, submitLabel, onSubmit) {
  const form = h('form', { class: 'form' }, ...fields, h('button', { class: 'primary', type: 'submit', text: submitLabel }));
  form.addEventListener('submit', e => { e.preventDefault(); act(form.querySelector('button[type=submit]'), () => onSubmit(formData(form))); });
  main.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'panel stack' },
    h('div', { class: 'row' }, h('span', { class: 'logo', text: S.config.org.logoText || initials(S.config.org.productName) }), h('span', { class: 'kicker', text: S.config.org.name })),
    h('h1', { text: title }), sub && h('p', { class: 'sub', text: sub }), form,
    h('button', { class: 'ghost small', type: 'button', onclick: () => $('#lang').click(), text: getLang() === 'en' ? 'Deutsch' : 'English' }))));
  form.querySelector('input')?.focus();
}
function field(name, labelKey, type = 'text', extra = {}) {
  return h('label', { class: 'f' }, t(labelKey), h('input', { name, type, required: extra.required !== false, autocomplete: extra.autocomplete, minlength: extra.minlength, value: extra.value }), extra.hint && h('span', { class: 'small', text: extra.hint }));
}
function viewSetup() {
  authCard(t('setup_title', { product: S.config.org.productName }), t('setup_sub'), [
    field('name', 'name', 'text', { autocomplete: 'name' }), field('email', 'email', 'email', { autocomplete: 'email' }),
    field('password', 'password', 'password', { autocomplete: 'new-password', minlength: 10, hint: t('pw_hint') })
  ], t('create_admin'), async d => { const r = await api('/setup', { method: 'POST', body: d }); S.me = r.user; S.config.needsSetup = false; location.hash = '#/'; render(); });
}
function viewLogin() {
  authCard(t('login_title', { product: S.config.org.productName }), S.config.demo ? t('demo_banner') : null, [
    field('email', 'email', 'email', { autocomplete: 'username' }), field('password', 'password', 'password', { autocomplete: 'current-password' })
  ], t('login'), async d => { const r = await api('/login', { method: 'POST', body: d }); S.me = r.user; render(); });
}

// ---------- launches ----------
let showArchived = false;
async function viewLaunches() {
  const list = await api('/launches' + (showArchived ? '?archived=1' : ''));
  const tplOptions = [h('option', { value: '', text: t('no_template') }), ...S.config.templates.map(tp => h('option', { value: tp.id, text: tp.name }))];
  const form = h('form', { class: 'form panel', hidden: true },
    h('h2', { text: t('new_launch') }),
    h('div', { class: 'two' }, field('name', 'launch_name'), h('label', { class: 'f' }, t('target_date'), h('input', { name: 'target_date', type: 'date' }))),
    h('label', { class: 'f' }, t('scope'), h('textarea', { name: 'scope' })),
    S.config.templates.length ? h('label', { class: 'f' }, t('template'), h('select', { name: 'templateId' }, ...tplOptions)) : null,
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit', text: t('create') }), h('button', { class: 'ghost', type: 'button', text: t('cancel'), onclick: () => { form.hidden = true; } })));
  form.addEventListener('submit', e => { e.preventDefault(); act(form.querySelector('[type=submit]'), async () => { const d = formData(form); const r = await api('/launches', { method: 'POST', body: { ...d, templateId: d.templateId || undefined } }); location.hash = '#/launch/' + r.launch.id; }); });

  const cards = list.length ? h('div', { class: 'cards' }, ...list.map(l => h('a', { class: 'card', href: '#/launch/' + l.id },
    h('div', { class: 'row between' }, badge(l.status), h('span', { class: 'mono muted', text: l.target_date || '' })),
    h('h3', { text: l.name }),
    h('div', { class: 'small muted', text: `${t('owner')}: ${l.owner_name} · ${l.check_count} ${t('checks')}${l.open_reviews ? ` · ${l.open_reviews} ${t('open_reviews')}` : ''}` }),
    l.evaluation.reasons.filter(r => r.level !== 'info').slice(0, 2).length ? h('ul', { class: 'reasons' }, ...l.evaluation.reasons.filter(r => r.level !== 'info').slice(0, 2).map(r => h('li', { class: r.level, text: t('r_' + r.code, { label: r.label }) }))) : null
  ))) : h('div', { class: 'empty', text: t('no_launches') });

  main.replaceChildren(
    S.config.demo ? demoBar() : null,
    h('div', { class: 'row between' }, h('div', {}, h('div', { class: 'kicker', text: S.config.org.name }), h('h1', { text: t('launches_title') })),
      h('div', { class: 'row' }, h('button', { class: 'ghost small', text: showArchived ? t('show_active') : t('show_archived'), onclick: () => { showArchived = !showArchived; render(); } }),
        h('button', { class: 'primary', text: '+ ' + t('new_launch'), onclick: () => { form.hidden = false; form.querySelector('input').focus(); } }))),
    h('p', { class: 'sub', text: t('launches_sub') }), form, h('div', { style: false }, cards));
}

function demoBar() {
  return h('div', { class: 'notice row between' }, h('span', { text: t('demo_banner') }),
    h('button', { class: 'ghost small', text: t('demo_toggle'), onclick: async e => {
      const r = await fetch('/demo/mapping', { method: 'POST' }).then(x => x.json()); toast(r.mappingFixed ? 'Demo CRM: company_size mapped ✓' : 'Demo CRM: company_size dropped ✕'); e.target.blur();
    } }));
}

// ---------- launch detail ----------
const CHECK_TEMPLATES = {
  http: { url: 'https://www.example.com/landing', expectBodyContains: 'Register' },
  json: { url: 'https://api.example.com/routing/preview?source=campaign', headers: { authorization: 'Bearer ${ENV:CRM_READ_TOKEN}' }, expect: { queue: 'inbound-sales' } },
  roundtrip: { submit: { url: 'https://forms.example.com/submit', method: 'POST', body: { email: '{{testId}}@example.test', company_size: '50-200' } }, verify: { url: 'https://crm.example.com/api/contacts/{{testId}}', headers: { authorization: 'Bearer ${ENV:CRM_READ_TOKEN}' }, waitMs: 3000, retries: 3 }, expect: { email: '{{testId}}@example.test', company_size: '50-200' } },
  manual: { instructions: 'Describe exactly what the person should check.' }
};

function chainState(c, ev) {
  const r = ev.reasons.find(x => x.checkId === c.id);
  if (!r) return ['pass', '✓'];
  if (r.code === 'GAP_ACCEPTED') return ['accepted', '≈'];
  if (r.code === 'GAP_OPEN') return ['gap', '!'];
  return [{ CHECK_FAILED: 'fail', CHECK_UNKNOWN: 'unknown', CHECK_STALE: 'stale', CHECK_NOT_RUN: 'none' }[r.code] ?? 'unknown', r.code === 'CHECK_FAILED' ? '✕' : '?'];
}

async function viewLaunch(id) {
  const [d, users, audit] = await Promise.all([api('/launches/' + id), S.users.length ? S.users : api('/users'), api(`/launches/${id}/audit`)]);
  S.users = users;
  const { launch, checks, exceptions, approvals, reviews, evaluation: ev } = d;
  const reload = () => viewLaunch(id);
  const st = ev.status;

  const hero = h('section', { class: `hero s-${st}` },
    h('div', { class: 'row between' }, h('a', { href: '#/', class: 'small muted', text: t('back') }), badge(st)),
    h('div', { class: 'kicker', text: launch.name }),
    h('div', { class: 'big', text: t('head_' + st) }),
    h('p', { class: 'muted', text: t('expl_' + st) }),
    ev.reasons.length ? h('ul', { class: 'reasons' }, ...ev.reasons.map(r => h('li', { class: r.level, text: t('r_' + r.code, { label: r.label }) }))) : null,
    h('div', { class: 'row mono muted small' }, h('span', { text: t('rules_version', { v: ev.rulesVersion }) }), h('span', { text: '·' }), h('span', { text: t('fingerprint', { fp: ev.fingerprint }) }), launch.target_date ? h('span', { text: '· ' + launch.target_date }) : null, h('span', { text: `· ${t('owner')}: ${launch.owner_name}` })));

  const chain = checks.length ? h('div', { class: 'chain', 'aria-label': t('chain') }, ...checks.map((c, i) => { const [cls, sym] = chainState(c, ev); return h('div', { class: 'cn r-' + cls }, h('div', { class: 'dot', text: sym }), h('span', { class: 'lbl', text: c.label })); })) : null;

  // checks panel
  const runAll = h('button', { class: 'primary', text: t('run_all'), onclick: e => act(e.currentTarget, async () => { await api(`/launches/${id}/run`, { method: 'POST' }); await reload(); }) });
  const checksPanel = h('section', { class: 'panel' },
    h('div', { class: 'row between' }, h('h2', { text: t('chain') }), h('div', { class: 'row' }, checks.some(c => c.type !== 'manual') ? runAll : null)),
    chain, h('div', { class: 'stack' }, ...checks.map(c => checkItem(c, ev, exceptions, reload))), addCheckForm(id, reload));

  main.replaceChildren(S.config.demo ? demoBar() : null, h('div', { class: 'stack' }, hero,
    h('div', { class: 'grid2' }, h('div', { class: 'stack' }, checksPanel, activityPanel(audit)),
      h('div', { class: 'stack' }, approvalPanel(launch, ev, approvals, reload), reviewsPanel(launch, reviews, reload), launchSettings(launch, reload)))));
}

function checkItem(c, ev, exceptions, reload) {
  const run = c.latestRun; const ex = exceptions.filter(e => e.check_id === c.id);
  const body = h('div', { class: 'stack' });
  const toggle = (node) => { body.replaceChildren(...(body.firstChild === node ? [] : [node])); };
  const actions = h('div', { class: 'row' },
    c.type !== 'manual' ? h('button', { class: 'ghost small', text: t('run'), onclick: e => act(e.currentTarget, async () => { await api(`/checks/${c.id}/run`, { method: 'POST' }); await reload(); }) }) : null,
    h('button', { class: c.type === 'manual' ? 'primary small' : 'ghost small', text: c.type === 'manual' ? t('attest') : t('report_broken'), onclick: () => toggle(attestForm(c, reload)) }),
    !c.critical && canApprove() ? h('button', { class: 'ghost small', text: t('accept_gap'), onclick: () => toggle(gapForm(c, reload)) }) : null,
    h('button', { class: 'ghost small', text: t('edit'), onclick: () => toggle(editCheckForm(c, reload)) }),
    h('button', { class: 'danger small', text: t('delete'), onclick: e => { if (confirm(t('confirm_delete'))) act(e.currentTarget, async () => { await api('/checks/' + c.id, { method: 'DELETE' }); await reload(); }); } }));
  return h('article', { class: 'check' },
    h('div', { class: 'head' }, h('b', { text: c.label }), h('span', { class: 'tag' + (c.critical ? ' crit' : ''), text: c.critical ? t('critical') : t('non_critical') }), h('span', { class: 'tag', text: t('type_' + c.type) })),
    c.config.instructions ? h('div', { class: 'small muted', text: `${t('instructions')}: ${c.config.instructions}` }) : null,
    run ? h('div', { class: 'res ' + run.status }, h('strong', { text: run.status.toUpperCase() }), ` · ${run.summary} · ${fmtDate(run.ran_at)}${run.ran_by_name ? ` · ${t('by')} ${run.ran_by_name}` : ''}`)
      : h('div', { class: 'res', text: t('never_run') }),
    run && Object.keys(run.evidence || {}).length ? h('details', { class: 'more' }, h('summary', { text: t('evidence') }), h('pre', { text: JSON.stringify(run.evidence, null, 2) })) : null,
    ...ex.map(e => h('div', { class: 'small row' }, h('span', { class: 'tag', text: t('exceptions') }), h('span', { text: `${e.reason} — ${e.accepted_by_name}, ${t('until')} ${fmtDate(e.expires_at)}` }),
      canApprove() ? h('button', { class: 'ghost small', text: t('revoke'), onclick: ev2 => act(ev2.currentTarget, async () => { await api('/exceptions/' + e.id, { method: 'DELETE' }); await reload(); }) }) : null)),
    actions, body);
}

function miniForm(fields, submitLabel, onSubmit, extraButtons = []) {
  const f = h('form', { class: 'inline-form' }, ...fields, h('div', { class: 'row' }, h('button', { class: 'primary small', type: 'submit', text: submitLabel }), ...extraButtons));
  f.addEventListener('submit', e => { e.preventDefault(); act(e.submitter ?? f.querySelector('[type=submit]'), () => onSubmit(formData(f), e.submitter)); });
  return f;
}
function attestForm(c, reload) {
  // Automated checks can only be reported as broken by hand; passing requires a real run.
  if (c.type !== 'manual') return miniForm([h('label', { class: 'f' }, t('evidence_note'), h('textarea', { name: 'note', required: true }))],
    '✕ ' + t('report_broken'), async d => { await api(`/checks/${c.id}/attest`, { method: 'POST', body: { note: d.note, status: 'fail' } }); await reload(); });
  return miniForm([
    h('label', { class: 'f' }, t('evidence_note'), h('textarea', { name: 'note', required: true })),
    h('label', { class: 'f' }, t('evidence_link'), h('input', { name: 'link', type: 'url', placeholder: 'https://' }))
  ], '✓ ' + t('attest_pass'), async (d, btn) => { await api(`/checks/${c.id}/attest`, { method: 'POST', body: { ...d, status: btn?.value === 'fail' ? 'fail' : 'pass' } }); await reload(); },
  [h('button', { class: 'danger small', type: 'submit', value: 'fail', text: '✕ ' + t('attest_fail') })]);
}
function gapForm(c, reload) {
  return miniForm([
    h('label', { class: 'f' }, t('gap_reason'), h('textarea', { name: 'reason', required: true })),
    h('label', { class: 'f' }, t('expires_days'), h('input', { name: 'expiresDays', type: 'number', min: 1, max: 90, value: 14 }))
  ], t('accept_gap'), async d => { await api(`/checks/${c.id}/exceptions`, { method: 'POST', body: { reason: d.reason, expiresDays: Number(d.expiresDays) } }); await reload(); });
}
function checkFields(c = {}) {
  const type = c.type ?? 'http';
  const ta = h('textarea', { name: 'config', class: 'code', spellcheck: 'false' }); ta.value = JSON.stringify(c.config ?? CHECK_TEMPLATES[type], null, 2);
  const sel = h('select', { name: 'type', onchange: e => { if (!c.id) ta.value = JSON.stringify(CHECK_TEMPLATES[e.target.value], null, 2); } }, ...Object.keys(CHECK_TEMPLATES).map(k => h('option', { value: k, selected: k === type, text: t('type_' + k) })));
  return [
    h('div', { class: 'two form' }, h('label', { class: 'f' }, t('label'), h('input', { name: 'label', required: true, value: c.label ?? '' })), h('label', { class: 'f' }, t('type'), sel)),
    h('label', { class: 'row small' }, h('input', { type: 'checkbox', name: 'critical', checked: c.critical ?? true }), t('critical')),
    h('p', { class: 'small muted', text: t('critical_hint') }),
    h('label', { class: 'f' }, t('config_json'), ta)];
}
function parseCheck(d) {
  let config; try { config = JSON.parse(d.config || '{}'); } catch { const e = new Error('x'); e.code = 'INVALID_JSON_INPUT'; throw e; }
  return { label: d.label, type: d.type, critical: d.critical === 'on', config };
}
function editCheckForm(c, reload) {
  return miniForm(checkFields(c), t('save'), async d => { await api('/checks/' + c.id, { method: 'PATCH', body: parseCheck(d) }); await reload(); });
}
function addCheckForm(launchId, reload) {
  const wrap = h('div', { class: 'stack' });
  const open = h('button', { class: 'ghost small', text: '+ ' + t('add_check'), onclick: () => { wrap.replaceChildren(miniForm(checkFields(), t('add_check'), async d => { await api(`/launches/${launchId}/checks`, { method: 'POST', body: parseCheck(d) }); await reload(); }, [h('button', { class: 'ghost small', type: 'button', text: t('cancel'), onclick: () => wrap.replaceChildren(open) })])); } });
  wrap.append(open);
  return h('div', { class: 'stack' }, wrap);
}

function approvalPanel(launch, ev, approvals, reload) {
  const last = approvals[0];
  const fourEyesBlocked = S.config.rules.fourEyes && launch.owner_id === S.me.id;
  const stateClass = { valid: 'ok', rejected: 'bad', missing: 'warn', stale: 'warn', expired: 'warn', self: 'bad' }[ev.approvalState];
  let controls;
  if (!canApprove()) controls = h('p', { class: 'small muted', text: t('approver_only') });
  else if (fourEyesBlocked) controls = h('p', { class: 'small muted', text: t('four_eyes', { name: launch.owner_name }) });
  else {
    controls = miniForm([h('label', { class: 'f' }, t('decision_note'), h('textarea', { name: 'note' }))], '✓ ' + t('approve'),
      async (d, btn) => { await api(`/launches/${launch.id}/decision`, { method: 'POST', body: { decision: btn?.value === 'rejected' ? 'rejected' : 'approved', note: d.note } }); await reload(); },
      [h('button', { class: 'danger small', type: 'submit', value: 'rejected', text: '✕ ' + t('reject') })]);
    if (ev.status === 'BLOCKED') controls.querySelector('button[type=submit]:not([value])').disabled = true;
  }
  return h('section', { class: 'panel stack' }, h('h2', { text: t('approval') }),
    h('div', { class: 'small' }, `${t('approval_state')}: `, h('strong', { class: stateClass, text: t('ap_' + ev.approvalState) })),
    last ? h('div', { class: 'small muted', text: `${last.decision === 'approved' ? '✓' : '✕'} ${last.approver_name} · ${fmtDate(last.created_at)}${last.note ? ' · “' + last.note + '”' : ''}` }) : null,
    h('p', { class: 'small muted mono', text: t('approval_binds', { fp: ev.fingerprint }) }), controls);
}

function reviewsPanel(launch, reviews, reload) {
  const opts = S.users.filter(u => !u.disabled).map(u => h('option', { value: u.id, text: u.name }));
  const due = new Date(Date.now() + S.config.rules.reviewDefaultDays * 864e5).toISOString().slice(0, 10);
  const form = miniForm([
    h('div', { class: 'two form' }, h('label', { class: 'f' }, t('assignee'), h('select', { name: 'assignee_id' }, ...opts)), h('label', { class: 'f' }, t('due'), h('input', { name: 'due', type: 'date', value: due, required: true }))),
    h('label', { class: 'f' }, t('note'), h('textarea', { name: 'note', required: true }))
  ], t('assign_review'), async d => { await api(`/launches/${launch.id}/reviews`, { method: 'POST', body: { assignee_id: Number(d.assignee_id), due_at: new Date(d.due + 'T17:00:00').getTime(), note: d.note } }); await reload(); });
  return h('section', { class: 'panel stack' }, h('h2', { text: t('reviews') }),
    reviews.length ? h('div', { class: 'stack' }, ...reviews.map(r => h('div', { class: 'small' },
      h('div', { class: 'row between' }, h('strong', { text: r.assignee_name }), h('span', { class: r.resolved_at ? 'ok' : r.overdue ? 'bad' : 'muted', text: r.resolved_at ? t('resolved') : (r.overdue ? t('overdue') + ' · ' : '') + fmtDate(r.due_at) })),
      h('div', { class: 'muted', text: r.note }),
      !r.resolved_at && (r.assignee_id === S.me.id || canApprove()) ? h('button', { class: 'ghost small', text: t('resolve'), onclick: e => act(e.currentTarget, async () => { await api(`/reviews/${r.id}/resolve`, { method: 'POST' }); await reload(); }) }) : null)))
      : h('p', { class: 'small muted', text: t('no_reviews') }), form);
}

function launchSettings(launch, reload) {
  const f = miniForm([
    h('label', { class: 'f' }, t('launch_name'), h('input', { name: 'name', value: launch.name, required: true })),
    h('label', { class: 'f' }, t('target_date'), h('input', { name: 'target_date', type: 'date', value: launch.target_date ?? '' })),
    (() => { const ta = h('textarea', { name: 'scope' }); ta.value = launch.scope; return h('label', { class: 'f' }, t('scope'), ta); })()
  ], t('save'), async d => { await api('/launches/' + launch.id, { method: 'PATCH', body: d }); toast(t('saved')); await reload(); },
  [h('button', { class: 'ghost small', type: 'button', text: launch.archived ? t('unarchive') : t('archive'), onclick: e => act(e.currentTarget, async () => { await api('/launches/' + launch.id, { method: 'PATCH', body: { archived: !launch.archived } }); location.hash = '#/'; }) })]);
  return h('details', { class: 'panel' }, h('summary', { text: t('settings_launch') }), h('div', { class: 'stack' }, f));
}

function auditRows(entries, withLaunch = false) {
  return h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: t('when') }), h('th', { text: t('who') }), h('th', { text: t('what') }), withLaunch ? h('th', { text: '#' }) : null, h('th', { text: t('details') }))),
    h('tbody', {}, ...entries.map(e => h('tr', {}, h('td', { class: 'mono', text: fmtDate(e.at) }), h('td', { text: e.actor_name ?? t('system') }), h('td', { class: 'mono', text: e.action }),
      withLaunch ? h('td', {}, e.launch_id ? h('a', { href: '#/launch/' + e.launch_id, text: e.launch_id }) : '') : null,
      h('td', { class: 'mono small muted', text: JSON.stringify(e.data) }))))));
}
function activityPanel(audit) {
  return h('details', { class: 'panel' }, h('summary', { text: `${t('activity')} (${audit.entries.length})` }), auditRows(audit.entries.slice(0, 60)));
}

// ---------- audit ----------
async function viewAudit() {
  const a = await api('/audit');
  main.replaceChildren(h('h1', { text: t('audit_title') }), h('p', { class: 'sub', text: t('audit_sub') }),
    h('p', { class: a.integrity.ok ? 'ok' : 'bad', text: a.integrity.ok ? '✓ ' + t('audit_ok') : '✕ ' + t('audit_broken', { id: a.integrity.brokenAt }) }),
    h('section', { class: 'panel' }, auditRows(a.entries, true)));
}

// ---------- settings ----------
async function viewSettings() {
  const [tokens, users] = await Promise.all([api('/tokens'), api('/users')]);
  S.users = users;
  const pw = miniForm([field('current', 'current_pw', 'password', { autocomplete: 'current-password' }), field('next', 'new_pw', 'password', { autocomplete: 'new-password', minlength: 10, hint: t('pw_hint') })],
    t('change_pw'), async (d) => { await api('/me/password', { method: 'POST', body: d }); toast(t('saved')); viewSettings(); });

  const secretBox = h('div');
  const tokenForm = miniForm([field('name', 'token_name')], t('create_token'), async d => {
    const r = await api('/tokens', { method: 'POST', body: d });
    await viewSettings();
    document.getElementById('secret-slot')?.replaceChildren(h('p', { class: 'small warn', text: t('token_once') }), h('div', { class: 'secret', text: r.token }));
  });

  const isAdmin = S.me.role === 'admin';
  const userForm = isAdmin ? miniForm([
    h('div', { class: 'two form' }, field('name', 'name'), field('email', 'email', 'email')),
    h('div', { class: 'two form' }, h('label', { class: 'f' }, t('role'), h('select', { name: 'role' }, ...['member', 'approver', 'admin'].map(r => h('option', { value: r, text: t('role_' + r) })))), field('password', 'temp_pw', 'text', { minlength: 10, hint: t('pw_hint') }))
  ], t('add_user'), async d => { await api('/users', { method: 'POST', body: d }); toast(t('saved')); viewSettings(); }) : null;

  const r = S.config.rules;
  main.replaceChildren(h('h1', { text: t('settings_title') }), h('p', { class: 'sub', text: `${S.me.name} · ${S.me.email}` }),
    h('div', { class: 'grid2' },
      h('div', { class: 'stack' },
        h('section', { class: 'panel stack' }, h('h2', { text: t('users') }),
          h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, ...users.map(u => h('tr', {},
            h('td', {}, h('strong', { text: u.name }), h('div', { class: 'small muted', text: u.email })),
            h('td', {}, isAdmin ? h('select', { 'aria-label': t('role'), onchange: e => api('/users/' + u.id, { method: 'PATCH', body: { role: e.target.value } }).then(() => toast(t('saved'))).catch(err => { fail(err); viewSettings(); }) }, ...['member', 'approver', 'admin'].map(x => h('option', { value: x, selected: u.role === x, text: t('role_' + x) }))) : h('span', { text: t('role_' + u.role) })),
            h('td', {}, u.disabled ? h('span', { class: 'bad small', text: t('disabled') }) : null, isAdmin && u.id !== S.me.id ? h('button', { class: 'ghost small', text: u.disabled ? t('enable') : t('disable'), onclick: e => act(e.currentTarget, async () => { await api('/users/' + u.id, { method: 'PATCH', body: { disabled: !u.disabled } }); viewSettings(); }) }) : null)
          ))))), userForm),
        h('section', { class: 'panel stack' }, h('h2', { text: t('tokens') }), h('p', { class: 'small muted', text: t('tokens_sub') }), h('div', { id: 'secret-slot' }, secretBox),
          tokens.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, ...tokens.map(tk => h('tr', {}, h('td', { text: tk.name }), h('td', { class: 'small muted', text: `${t('last_used')}: ${tk.last_used_at ? fmtDate(tk.last_used_at) : t('never')}` }),
            h('td', {}, h('button', { class: 'danger small', text: t('revoke'), onclick: e => act(e.currentTarget, async () => { await api('/tokens/' + tk.id, { method: 'DELETE' }); viewSettings(); }) }))))))) : null, tokenForm)),
      h('div', { class: 'stack' },
        h('section', { class: 'panel stack' }, h('h2', { text: t('profile') }), pw),
        h('section', { class: 'panel stack' }, h('h2', { text: t('personalise') }), h('p', { class: 'small muted', text: t('personalise_sub') }),
          h('table', {}, h('tbody', {},
            h('tr', {}, h('td', { text: t('max_age') }), h('td', { class: 'mono', text: `${r.maxCheckAgeHours} ${t('hours')}` })),
            h('tr', {}, h('td', { text: t('approval_days') }), h('td', { class: 'mono', text: `${r.approvalValidDays} ${t('days')}` })),
            h('tr', {}, h('td', { text: t('four_eyes_on') }), h('td', { class: 'mono', text: r.fourEyes ? t('on') : t('off') })),
            h('tr', {}, h('td', { text: t('template') }), h('td', { class: 'small', text: S.config.templates.map(x => x.name).join(' · ') || '—' })),
            h('tr', {}, h('td', { text: 'Rules' }), h('td', { class: 'mono', text: S.config.rulesVersion }))))))));
}

// ---------- boot ----------
(async function boot() {
  S.config = await api('/config');
  let saved = null; try { saved = localStorage.getItem('verax.lang'); } catch {}
  setLang(saved || S.config.language);
  applyBranding();
  if (!S.config.needsSetup) { try { S.me = (await api('/me')).user; } catch { S.me = null; } }
  render();
})();
