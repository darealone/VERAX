// Demo mode only: a fake landing page, form endpoint and "CRM" so checks run against real HTTP.
// Nothing here is used outside `verax serve --demo`.

export function mountDemo() {
  const crm = new Map();
  const state = { mappingFixed: false };

  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  return async function demo(req, res, url) {
    const p = url.pathname;
    if (p === '/demo/landing' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Demo webinar</title><h1>Autumn webinar</h1><form method="post" action="/demo/form"><button>Register</button></form>');
    }
    if (p === '/demo/form' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      const id = String(body.email ?? '').split('@')[0];
      // The simulated bug: company_size is dropped by the form → CRM field mapping.
      const record = { email: body.email, source: body.source, ...(state.mappingFixed ? { company_size: body.company_size } : {}) };
      crm.set(id, record);
      if (crm.size > 500) crm.delete(crm.keys().next().value);
      return json(res, 201, { ok: true });
    }
    const m = p.match(/^\/demo\/crm\/contacts\/([\w-]+)$/);
    if (m && req.method === 'GET') return crm.has(m[1]) ? json(res, 200, crm.get(m[1])) : json(res, 404, { error: 'not found' });
    if (p === '/demo/crm/routing' && req.method === 'GET') return json(res, 200, { source: url.searchParams.get('source'), queue: 'inbound-sales', rule: 'R-12' });
    if (p === '/demo/mapping' && req.method === 'POST') {
      state.mappingFixed = !state.mappingFixed;
      return json(res, 200, { mappingFixed: state.mappingFixed });
    }
    if (p === '/demo/mapping' && req.method === 'GET') return json(res, 200, { mappingFixed: state.mappingFixed });
    json(res, 404, { error: 'not found' });
  };
}

export function demoChecks(base) {
  return [
    { label: 'Landing page reachable', type: 'http', critical: true, config: { url: `${base}/demo/landing`, expectBodyContains: 'Register' } },
    {
      label: 'Form → CRM required fields', type: 'roundtrip', critical: true,
      config: {
        submit: { url: `${base}/demo/form`, method: 'POST', body: { email: '{{testId}}@example.test', company_size: '50-200', source: 'webinar' } },
        verify: { url: `${base}/demo/crm/contacts/{{testId}}`, waitMs: 300, retries: 2 },
        expect: { email: '{{testId}}@example.test', company_size: '50-200', source: 'webinar' }
      }
    },
    { label: 'Lead routing rule', type: 'json', critical: true, config: { url: `${base}/demo/crm/routing?source=webinar`, expect: { queue: 'inbound-sales' } } },
    { label: 'Tracking & attribution validated', type: 'manual', critical: false, config: { instructions: 'Open the analytics debug view, submit a test registration and confirm the conversion event arrives with campaign parameters.' } }
  ];
}
