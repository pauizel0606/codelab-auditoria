// =====================================================================
//  Codelab · Auditoría web — servidor (Cloudflare Worker, plan gratuito)
//
//  POST /audit  { "url": "https://ejemplo.com", "lang": "es" }
//  Visita la web, la analiza y devuelve las comprobaciones por categoría.
//  Si existe el secreto PSI_KEY, añade también la nota de Google PageSpeed.
// =====================================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 CodelabAudit/1.0 (+https://codelab.pauizel.com)';
const WEIGHTS = { fail: 0, warn: 0.5, pass: 1 };
const hits = new Map(); // límite de peticiones por IP (por instancia)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (url.pathname === '/') return json({ ok: true, service: 'codelab-auditoria' }, 200, headers);
    if (url.pathname === '/audit' && req.method === 'POST') {
      if (!rateOk(req.headers.get('CF-Connecting-IP') || 'x')) return json({ error: 'rate_limited' }, 429, headers);
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400, headers); }
      const target = normalize(body && body.url);
      if (!target) return json({ error: 'invalid_url' }, 400, headers);
      const lang = body.lang === 'ca' ? 'ca' : 'es';
      try {
        const limit = env.PSI_KEY ? 65000 : 30000;
        const report = await Promise.race([
          audit(target, lang, env),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), limit))
        ]);
        return json(report, 200, headers);
      } catch (e) {
        const msg = String(e && e.message || e);
        const code = /domain_not_found/.test(msg) ? 'domain_not_found' : /timeout/.test(msg) ? 'timeout' : 'fetch_failed';
        return json({ error: code, detail: msg.slice(0, 200) }, 502, headers);
      }
    }
    return json({ error: 'not_found' }, 404, headers);
  }
};

/* ------------------------------ utilidades ------------------------------ */
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const ok = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return { 'Access-Control-Allow-Origin': ok, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
}
function rateOk(ip) {
  const now = Date.now(), win = 60000, max = 8;
  const list = (hits.get(ip) || []).filter(t => now - t < win);
  if (list.length >= max) { hits.set(ip, list); return false; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return true;
}
function normalize(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 500) return null;
  let v = raw.trim();
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    if (!isSafe(u)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}
function isSafe(u) {
  if (!/^https?:$/.test(u.protocol)) return false;
  if (u.port && !['80', '443'].includes(u.port)) return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || /\.(local|internal|localhost|lan|home)$/.test(h)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || p[0] >= 224) return false;
  }
  if (h.startsWith('[')) return false; // IPv6 literal
  return true;
}
async function get(url, opts = {}) {
  return fetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': UA, 'Accept': opts.accept || 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9,ca;q=0.8,en;q=0.5', 'Accept-Encoding': 'gzip, deflate, br' },
    signal: AbortSignal.timeout(opts.timeout || 15000),
    cf: { cacheTtl: 0 }
  });
}
async function follow(url, max = 6) {
  let cur = url; const hops = [];
  for (let i = 0; i <= max; i++) {
    const u = new URL(cur);
    if (!isSafe(u)) throw new Error('unsafe_redirect');
    const t0 = Date.now();
    const r = await get(cur);
    const ms = Date.now() - t0;
    const loc = r.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
      hops.push({ url: cur, status: r.status, ms });
      cur = new URL(loc, cur).href;
      continue;
    }
    return { res: r, finalUrl: cur, hops, ms };
  }
  throw new Error('too_many_redirects');
}
async function exists(url, accept) {
  try {
    const r = await get(url, { accept: accept || '*/*', timeout: 8000 });
    if ([301, 302, 307, 308].includes(r.status) && r.headers.get('location')) {
      const r2 = await get(new URL(r.headers.get('location'), url).href, { accept: accept || '*/*', timeout: 8000 });
      return { ok: r2.ok, status: r2.status, text: r2.ok ? (await r2.text()).slice(0, 20000) : '' };
    }
    return { ok: r.ok, status: r.status, text: r.ok ? (await r.text()).slice(0, 20000) : '' };
  } catch { return { ok: false, status: 0, text: '' }; }
}

/* ------------------------------- análisis ------------------------------- */
async function parseHtml(html) {
  const d = {
    lang: null, title: '', titleCount: 0, description: null, viewport: null, robots: null, canonical: null,
    ogTitle: false, ogImage: false, ldJson: 0, h1: 0, h1Text: '', imgs: 0, imgNoAlt: 0, imgLazy: 0,
    scripts: 0, headBlocking: 0, styles: 0, favicon: false, generator: null, mixed: 0, iframes: 0,
    inputs: 0, inputsLabelled: 0, labelFor: new Set(), inputIds: [], charset: false, links: 0
  };
  let inH1 = false;
  const rw = new HTMLRewriter()
    .on('html', { element(e) { d.lang = e.getAttribute('lang'); } })
    .on('head title', { element() { d.titleCount++; }, text(t) { if (d.titleCount === 1) d.title += t.text; } })
    .on('meta', {
      element(e) {
        const n = (e.getAttribute('name') || '').toLowerCase(), p = (e.getAttribute('property') || '').toLowerCase(), c = e.getAttribute('content');
        if (e.getAttribute('charset')) d.charset = true;
        if (n === 'description') d.description = c || '';
        if (n === 'viewport') d.viewport = c || '';
        if (n === 'robots') d.robots = c || '';
        if (n === 'generator') d.generator = c || '';
        if (p === 'og:title') d.ogTitle = true;
        if (p === 'og:image') d.ogImage = true;
      }
    })
    .on('link', {
      element(e) {
        const rel = (e.getAttribute('rel') || '').toLowerCase();
        if (rel === 'canonical') d.canonical = e.getAttribute('href');
        if (rel.includes('icon')) d.favicon = true;
        if (rel === 'stylesheet') { d.styles++; if (/^http:\/\//i.test(e.getAttribute('href') || '')) d.mixed++; }
      }
    })
    .on('script', {
      element(e) {
        const type = (e.getAttribute('type') || '').toLowerCase();
        if (type === 'application/ld+json') { d.ldJson++; return; }
        if (e.getAttribute('src')) { d.scripts++; if (/^http:\/\//i.test(e.getAttribute('src'))) d.mixed++; }
      }
    })
    .on('head script[src]', {
      element(e) {
        const type = (e.getAttribute('type') || '').toLowerCase();
        if (e.getAttribute('async') === null && e.getAttribute('defer') === null && type !== 'module') d.headBlocking++;
      }
    })
    .on('h1', { element(e) { d.h1++; inH1 = d.h1 === 1; e.onEndTag(() => { inH1 = false; }); }, text(t) { if (inH1 && d.h1Text.length < 140) d.h1Text += t.text; } })
    .on('img', {
      element(e) {
        d.imgs++;
        if (e.getAttribute('alt') === null) d.imgNoAlt++;
        if ((e.getAttribute('loading') || '').toLowerCase() === 'lazy') d.imgLazy++;
        if (/^http:\/\//i.test(e.getAttribute('src') || '')) d.mixed++;
      }
    })
    .on('iframe', { element() { d.iframes++; } })
    .on('a[href]', { element() { d.links++; } })
    .on('label[for]', { element(e) { d.labelFor.add(e.getAttribute('for')); } })
    .on('input, select, textarea', {
      element(e) {
        const type = (e.getAttribute('type') || '').toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return;
        d.inputs++;
        if (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title')) { d.inputsLabelled++; return; }
        d.inputIds.push(e.getAttribute('id'));
      }
    })
    .on('label input, label select, label textarea', { element() { d.inputsLabelled++; d.inputIds.pop(); } });
  await rw.transform(new Response(html)).arrayBuffer();
  d.inputsLabelled += d.inputIds.filter(id => id && d.labelFor.has(id)).length;
  d.title = d.title.replace(/\s+/g, ' ').trim();
  d.h1Text = d.h1Text.replace(/\s+/g, ' ').trim();
  return d;
}

async function resolves(host) {
  const q = async type => {
    const r = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=' + type, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return (j.Answer || []).filter(a => a.type === 1 || a.type === 28).map(a => a.data);
  };
  const [a, aaaa] = await Promise.all([q('A').catch(() => []), q('AAAA').catch(() => [])]);
  const ips = a.concat(aaaa);
  if (!ips.length) return false;
  // No analizamos dominios que apuntan a direcciones privadas
  return !ips.every(ip => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80)/i.test(ip));
}

async function audit(target, lang, env) {
  if (!(await resolves(new URL(target).hostname))) throw new Error('domain_not_found');
  const psiPromise = env.PSI_KEY ? psi(target, lang, env.PSI_KEY).catch(() => null) : Promise.resolve(null);

  let t0 = Date.now(), certError = false, first;
  try {
    first = await follow(target);
    // En Cloudflare, un certificado no válido no lanza error: devuelve una página 525/526
    if (/^https:/i.test(first.finalUrl) && [525, 526].includes(first.res.status)) throw new Error('cert_invalid');
  } catch (e) {
    // Si HTTPS falla (p. ej. certificado no válido), probamos por HTTP para poder analizar igualmente
    if (!/^https:/i.test(target)) throw e;
    first = await follow(target.replace(/^https:/i, 'http:'));
    certError = true;
    t0 = Date.now() - first.ms;
  }
  const { res, finalUrl, hops, ms } = first;
  const ttfb = hops.reduce((a, h) => a + h.ms, 0) + ms;
  const buf = await res.arrayBuffer();
  const total = Date.now() - t0;
  const html = new TextDecoder().decode(buf);
  const bytes = buf.byteLength;
  const H = k => res.headers.get(k);
  const final = new URL(finalUrl);
  const isHttps = final.protocol === 'https:';
  const ctype = (H('content-type') || '').toLowerCase();
  const d = /html/.test(ctype) || /<html/i.test(html.slice(0, 2000)) ? await parseHtml(html) : await parseHtml('');

  const origin = final.origin;
  const [robots, httpVersion] = await Promise.all([
    exists(origin + '/robots.txt', 'text/plain'),
    isHttps ? (async () => { try { const r = await get('http://' + final.host + final.pathname, { timeout: 8000 }); return { status: r.status, location: r.headers.get('location') || '' }; } catch { return null; } })() : Promise.resolve(null)
  ]);
  const sitemapUrl = ((robots.text.match(/^\s*sitemap:\s*(\S+)/im) || [])[1]) || origin + '/sitemap.xml';
  const sitemap = await exists(sitemapUrl, 'application/xml,text/xml,*/*');
  const sitemapOk = sitemap.ok && /<(urlset|sitemapindex)/i.test(sitemap.text);

  const checks = [];
  const add = (id, cat, status, weight, value) => checks.push({ id, cat, status, weight, value: value == null ? null : value });
  const okStatus = res.status >= 200 && res.status < 300;

  // ---- Seguridad
  if (certError) add('cert', 'security', 'fail', 4);
  add('https', 'security', isHttps ? 'pass' : 'fail', 3);
  if (isHttps && httpVersion) add('http_redirect', 'security', (httpVersion.status >= 300 && httpVersion.status < 400 && /^https:/i.test(httpVersion.location)) ? 'pass' : 'warn', 2);
  add('hsts', 'security', isHttps && H('strict-transport-security') ? 'pass' : 'warn', 1.5);
  const csp = H('content-security-policy') || '';
  add('csp', 'security', csp ? 'pass' : 'warn', 1);
  add('xcto', 'security', /nosniff/i.test(H('x-content-type-options') || '') ? 'pass' : 'warn', 1);
  add('frame', 'security', (H('x-frame-options') || /frame-ancestors/i.test(csp)) ? 'pass' : 'warn', 1);
  add('referrer', 'security', H('referrer-policy') ? 'pass' : 'warn', 0.5);
  if (isHttps) add('mixed', 'security', d.mixed ? 'fail' : 'pass', 2, d.mixed);
  const leak = [H('x-powered-by'), H('server')].filter(v => v && /\d/.test(v)).join(' · ');
  add('version_leak', 'security', leak ? 'warn' : 'pass', 0.5, leak || null);

  // ---- SEO
  add('status', 'seo', okStatus ? 'pass' : 'fail', 3, res.status);
  const tl = d.title.length;
  add('title', 'seo', !tl ? 'fail' : (tl < 10 || tl > 65 ? 'warn' : 'pass'), 2.5, d.title || null);
  const dl = d.description == null ? 0 : d.description.trim().length;
  add('description', 'seo', !dl ? 'fail' : (dl < 50 || dl > 170 ? 'warn' : 'pass'), 2, d.description ? d.description.trim().slice(0, 200) : null);
  add('h1', 'seo', d.h1 === 0 ? 'fail' : (d.h1 > 1 ? 'warn' : 'pass'), 1.5, d.h1 ? (d.h1 === 1 ? d.h1Text : d.h1) : 0);
  add('viewport', 'seo', d.viewport && /width\s*=\s*device-width/i.test(d.viewport) ? 'pass' : 'fail', 2);
  const noindex = /noindex/i.test(d.robots || '') || /noindex/i.test(H('x-robots-tag') || '');
  add('indexable', 'seo', noindex ? 'fail' : 'pass', 3);
  add('canonical', 'seo', d.canonical ? 'pass' : 'warn', 1);
  add('robots_txt', 'seo', robots.ok ? 'pass' : 'warn', 1);
  add('sitemap', 'seo', sitemapOk ? 'pass' : 'warn', 1.5);
  add('og', 'seo', d.ogTitle && d.ogImage ? 'pass' : 'warn', 1);
  add('schema', 'seo', d.ldJson ? 'pass' : 'warn', 0.8);
  add('favicon', 'seo', d.favicon ? 'pass' : 'warn', 0.5);

  // ---- Accesibilidad
  add('lang', 'accessibility', d.lang ? 'pass' : 'fail', 2, d.lang);
  if (d.imgs) add('img_alt', 'accessibility', d.imgNoAlt === 0 ? 'pass' : (d.imgNoAlt / d.imgs > 0.2 ? 'fail' : 'warn'), 2.5, d.imgNoAlt + '/' + d.imgs);
  const noZoom = d.viewport && (/user-scalable\s*=\s*(no|0)/i.test(d.viewport) || /maximum-scale\s*=\s*1(\.0)?\b/i.test(d.viewport));
  if (d.viewport) add('zoom', 'accessibility', noZoom ? 'warn' : 'pass', 1.5);
  if (d.inputs) add('labels', 'accessibility', d.inputsLabelled >= d.inputs ? 'pass' : 'warn', 2, (d.inputs - Math.min(d.inputs, d.inputsLabelled)) + '/' + d.inputs);
  add('doc_title', 'accessibility', tl ? 'pass' : 'fail', 1);
  if (d.h1 !== undefined) add('headings', 'accessibility', d.h1 ? 'pass' : 'warn', 1);

  // ---- Rendimiento
  add('ttfb', 'performance', ttfb < 600 ? 'pass' : ttfb < 1500 ? 'warn' : 'fail', 3, ttfb);
  add('html_size', 'performance', bytes < 120000 ? 'pass' : bytes < 350000 ? 'warn' : 'fail', 1.5, bytes);
  const enc = (H('content-encoding') || '').toLowerCase();
  add('compression', 'performance', enc ? 'pass' : (bytes < 8000 ? 'pass' : 'fail'), 2, enc || null);
  add('redirects', 'performance', hops.length <= 1 ? 'pass' : 'warn', 1, hops.length);
  add('blocking_js', 'performance', d.headBlocking === 0 ? 'pass' : d.headBlocking <= 2 ? 'warn' : 'fail', 2, d.headBlocking);
  add('requests', 'performance', d.scripts + d.styles <= 25 ? 'pass' : d.scripts + d.styles <= 45 ? 'warn' : 'fail', 1, d.scripts + d.styles);
  if (d.imgs > 4) add('lazy_img', 'performance', d.imgLazy / d.imgs >= 0.3 ? 'pass' : 'warn', 1, d.imgLazy + '/' + d.imgs);
  add('cache', 'performance', /max-age|s-maxage|immutable/i.test(H('cache-control') || '') || H('etag') || H('last-modified') ? 'pass' : 'warn', 0.8);

  const psiData = await psiPromise;

  const categories = {};
  ['performance', 'seo', 'accessibility', 'security'].forEach(cat => {
    const list = checks.filter(c => c.cat === cat);
    const w = list.reduce((a, c) => a + c.weight, 0);
    let score = w ? list.reduce((a, c) => a + c.weight * WEIGHTS[c.status], 0) / w : 0;
    if (cat === 'performance' && psiData && typeof psiData.score === 'number') score = psiData.score * 0.7 + score * 0.3;
    categories[cat] = { score: Math.round(score * 100) / 100 };
  });

  return {
    url: target, finalUrl, fetchedAt: new Date().toISOString(), lang,
    status: res.status, timing: { ttfb, total }, bytes,
    platform: detectPlatform(d.generator, html, res.headers),
    categories, checks: checks.map(({ weight, ...c }) => c), psi: psiData
  };
}

function detectPlatform(gen, html, headers) {
  const s = (gen || '') + ' ' + (headers.get('x-powered-by') || '') + ' ' + (headers.get('server') || '');
  const h = html.slice(0, 200000);
  if (/wordpress/i.test(s) || /wp-content\//.test(h)) return 'WordPress';
  if (/shopify/i.test(s) || /cdn\.shopify\.com/.test(h)) return 'Shopify';
  if (/wix\.com/i.test(s) || /static\.wixstatic\.com/.test(h)) return 'Wix';
  if (/squarespace/i.test(s + h.slice(0, 50000))) return 'Squarespace';
  if (/webflow/i.test(s) || /webflow\.com/.test(h.slice(0, 50000))) return 'Webflow';
  if (/joomla/i.test(s)) return 'Joomla';
  if (/prestashop/i.test(s + h.slice(0, 50000))) return 'PrestaShop';
  if (/__next|_next\/static/.test(h)) return 'Next.js';
  if (gen) return gen.slice(0, 40);
  return null;
}

async function psi(target, lang, key) {
  const p = new URLSearchParams({ url: target, strategy: 'mobile', category: 'PERFORMANCE', locale: lang, key });
  const r = await fetch('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + p, { signal: AbortSignal.timeout(55000) });
  if (!r.ok) return null;
  const j = await r.json();
  const lh = j.lighthouseResult; if (!lh) return null;
  const pick = id => lh.audits[id] ? { display: lh.audits[id].displayValue || null, score: lh.audits[id].score } : null;
  return {
    score: lh.categories.performance.score,
    metrics: {
      fcp: pick('first-contentful-paint'), lcp: pick('largest-contentful-paint'), tbt: pick('total-blocking-time'),
      cls: pick('cumulative-layout-shift'), si: pick('speed-index')
    }
  };
}
