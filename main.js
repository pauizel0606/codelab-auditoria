(function () {
  'use strict';

  var root = document.documentElement;
  var CFG = window.AUDIT_CONFIG || {};
  var CATS = ['performance', 'seo', 'accessibility', 'security'];
  var state = { report: null, sample: false, filter: 'all', running: false };

  function $(id) { return document.getElementById(id); }
  function lang() { return root.getAttribute('lang') === 'ca' ? 'ca' : 'es'; }
  function t(k) { var d = window.I18N[lang()]; return d[k] != null ? d[k] : window.I18N.es[k]; }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function band(score) { return score == null ? 'na' : score >= 0.9 ? 'good' : score >= 0.5 ? 'mid' : 'bad'; }
  function num(n, d) { return Number(n).toLocaleString(lang() === 'ca' ? 'ca-ES' : 'es-ES', { maximumFractionDigits: d || 0 }); }

  $('year').textContent = new Date().getFullYear();

  /* =================== Idioma =================== */
  function applyLang() {
    var d = window.I18N[lang()];
    document.querySelectorAll('[data-i18n]').forEach(function (el) { var v = d[el.getAttribute('data-i18n')]; if (typeof v === 'string') el.innerHTML = v; });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) { var v = d[el.getAttribute('data-i18n-aria')]; if (v) el.setAttribute('aria-label', v); });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { var v = d[el.getAttribute('data-i18n-ph')]; if (v) el.setAttribute('placeholder', v); });
    document.title = d['meta.title'];
    document.querySelectorAll('[data-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang())); });
    updateMail();
  }
  function setLang(l) {
    if (l === lang()) return;
    document.body.classList.add('lang-switching');
    setTimeout(function () {
      root.setAttribute('lang', l); save('codelab-lang', l);
      applyLang();
      if (state.report) renderReport(state.report, false, state.sample);
      document.body.classList.remove('lang-switching');
    }, 220);
  }
  document.querySelectorAll('[data-lang]').forEach(function (b) { b.addEventListener('click', function () { setLang(b.getAttribute('data-lang')); }); });

  /* =================== Tema, menú, cabecera =================== */
  $('themeToggle').addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.classList.add('theme-anim'); root.setAttribute('data-theme', next); save('codelab-theme', next);
    setTimeout(function () { root.classList.remove('theme-anim'); }, 600);
  });
  var toggle = document.querySelector('.nav__toggle');
  toggle.addEventListener('click', function () { var o = document.body.classList.toggle('menu-open'); toggle.setAttribute('aria-expanded', String(o)); });
  document.querySelectorAll('.nav__links a').forEach(function (a) { a.addEventListener('click', function () { document.body.classList.remove('menu-open'); toggle.setAttribute('aria-expanded', 'false'); }); });
  var nav = $('nav'); var onScroll = function () { nav.classList.toggle('nav--scrolled', window.scrollY > 10); };
  onScroll(); window.addEventListener('scroll', onScroll, { passive: true });

  root.classList.add('js');
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }) : null;
  function observe(scope) { (scope || document).querySelectorAll('.reveal:not(.in)').forEach(function (el) { io ? io.observe(el) : el.classList.add('in'); }); }
  observe();
  var faq = document.querySelectorAll('.faq details');
  faq.forEach(function (d) { d.addEventListener('toggle', function () { if (d.open) faq.forEach(function (o) { if (o !== d) o.open = false; }); }); });

  /* =================== Correo =================== */
  var chosenService = null;
  function mailto() {
    var lines = [t('mail.hello'), ''];
    if (chosenService) lines.push(t('mail.service') + ': ' + t(chosenService));
    var r = state.report;
    if (r && !state.sample) {
      lines.push(t('mail.web') + ': ' + r.finalUrl, '', t('mail.scores') + ':');
      CATS.forEach(function (c) { if (r.categories[c]) lines.push('· ' + t('r.cat.' + c) + ': ' + Math.round(r.categories[c].score * 100) + '/100'); });
    } else lines.push(t('mail.web') + ': ');
    return 'mailto:' + (CFG.email || '') + '?subject=' + encodeURIComponent('Codelab · ' + t('mail.subject')) + '&body=' + encodeURIComponent(lines.join('\n'));
  }
  function updateMail() { var m = $('ctaMail'); if (m) m.href = mailto(); var r = $('reportMail'); if (r) r.href = mailto(); }
  document.querySelectorAll('[data-service]').forEach(function (b) { b.addEventListener('click', function () { chosenService = b.getAttribute('data-service'); updateMail(); }); });

  /* =================== Formulario =================== */
  function normalizeUrl(raw) {
    var v = (raw || '').trim();
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try { var u = new URL(v); if (!/\./.test(u.hostname) || /\s/.test(v)) return null; return u.href; } catch (e) { return null; }
  }
  function showError(msg) { var e = $('formError'); if (!msg) { e.hidden = true; e.textContent = ''; return; } e.textContent = msg; e.hidden = false; }

  $('scanForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (state.running) return;
    var url = normalizeUrl($('url').value);
    if (!url) { showError(t('err.url')); $('url').focus(); return; }
    showError(null);
    analyze(url);
  });
  $('sampleBtn').addEventListener('click', function () { showError(null); loadSample(true); });

  /* =================== Progreso =================== */
  var progTimer = null;
  function startProgress(url) {
    var steps = t('p.steps');
    $('progressUrl').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    $('progressList').innerHTML = steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    $('progressStep').textContent = t('p.wait');
    $('report').hidden = true; $('progress').hidden = false;
    var items = $('progressList').children, i = 0, start = Date.now();
    items[0].classList.add('active');
    progTimer = setInterval(function () {
      var s = (Date.now() - start) / 1000;
      $('progressBar').style.width = (95 * (1 - Math.exp(-s / 2.5))).toFixed(1) + '%';
      var target = Math.min(items.length - 1, Math.floor(s / 0.55));
      while (i < target) { items[i].classList.remove('active'); items[i].classList.add('done'); i++; items[i].classList.add('active'); }
    }, 120);
    $('progress').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function stopProgress() { clearInterval(progTimer); $('progress').hidden = true; $('progressBar').style.width = '0'; }

  /* =================== Análisis =================== */
  function analyze(url) {
    state.running = true; $('scanBtn').disabled = true;
    startProgress(url);
    var minWait = new Promise(function (r) { setTimeout(r, 3400); }); // deja ver el progreso
    var req = fetch(String(CFG.apiUrl || '').replace(/\/$/, '') + '/audit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, lang: lang() })
    }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (b) { return { status: res.status, body: b }; }); });

    Promise.all([req, minWait]).then(function (x) {
      var r = x[0];
      stopProgress();
      if (r.status === 200 && r.body.categories) { renderReport(r.body, true, false); return; }
      var code = r.body && r.body.error;
      showError(t(code === 'domain_not_found' || code === 'invalid_url' ? 'err.domain' : code === 'timeout' ? 'err.timeout' : code === 'rate_limited' ? 'err.rate' : 'err.fetch'));
      scrollToForm();
    }).catch(function () {
      stopProgress(); showError(t('err.network')); scrollToForm();
    }).then(function () { state.running = false; $('scanBtn').disabled = false; });
  }

  function loadSample(scroll) {
    fetch('data/ejemplo.json').then(function (r) { return r.json(); })
      .then(function (d) { renderReport(d, scroll, true); })
      .catch(function () { showError(t('err.network')); });
  }
  function scrollToForm() {
    $('analizar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(function () { $('url').focus({ preventScroll: true }); }, 500);
  }

  /* =================== Informe =================== */
  function gauge(score, label, big) {
    var pct = Math.round((score || 0) * 100), r = big ? 54 : 40, c = 2 * Math.PI * r, size = big ? 132 : 100;
    return '<div class="gauge gauge--' + band(score) + (big ? ' gauge--big' : '') + '">' +
      '<svg viewBox="0 0 ' + size + ' ' + size + '" aria-hidden="true"><circle class="gauge__track" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '"/>' +
      '<circle class="gauge__val" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + c.toFixed(2) + '" data-off="' + (c * (1 - pct / 100)).toFixed(2) + '"/></svg>' +
      '<span class="gauge__num" data-to="' + pct + '">0</span>' + (label ? '<span class="gauge__label">' + esc(label) + '</span>' : '') + '</div>';
  }
  function fmtValue(c) {
    var v = c.value;
    if (v == null) return '';
    if (c.id === 'ttfb') return num(v) + ' ms';
    if (c.id === 'html_size') return num(v / 1024, v < 10240 ? 1 : 0) + ' KB';
    if (c.id === 'img_alt' || c.id === 'labels' || c.id === 'lazy_img') { var p = String(v).split('/'); return lang() === 'ca' ? p[0] + ' de ' + p[1] : p[0] + ' de ' + p[1]; }
    return String(v);
  }
  function checkText(c, key) {
    var T = (window.CHECKS[lang()] || window.CHECKS.es)[c.id];
    if (!T) return c.id;
    return T[key].replace('{v}', esc(fmtValue(c)));
  }

  function renderReport(rep, scroll, isSample) {
    state.report = rep; state.sample = !!isSample; state.filter = 'all';
    var scores = CATS.map(function (c) { return rep.categories[c] ? rep.categories[c].score : 0; });
    var global = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
    var gb = band(global);
    var host = rep.finalUrl || rep.url;
    var dateStr = new Date(rep.fetchedAt || Date.now()).toLocaleDateString(lang() === 'ca' ? 'ca-ES' : 'es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    var issues = rep.checks.filter(function (c) { return c.status !== 'pass'; })
      .sort(function (a, b) { return (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1) || CATS.indexOf(a.cat) - CATS.indexOf(b.cat); });
    var passed = rep.checks.filter(function (c) { return c.status === 'pass'; });
    var isHttps = /^https:/.test(host) && !rep.checks.some(function (c) { return c.id === 'cert'; });

    var html = '';
    if (state.sample) html += '<div class="report__sample reveal"><strong>' + t('r.sample') + '</strong> · ' + t('r.sampleNote') + '</div>';
    html += '<header class="report__head reveal"><div class="report__id"><p class="kicker">' + t('r.title') + '</p>' +
      '<h2><a href="' + esc(host) + '" target="_blank" rel="noopener">' + esc(host.replace(/^https?:\/\//, '').replace(/\/$/, '')) + '</a></h2>' +
      '<p class="report__meta">' + t('r.date') + ' ' + esc(dateStr) + '</p></div>' +
      '<div class="report__actions"><button type="button" class="btn btn--ghost btn--sm" id="printBtn">' + t('r.print') + '</button>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="againBtn">' + t('r.again') + '</button></div></header>';

    html += '<div class="report__summary reveal"><div class="report__global">' + gauge(global, null, true) +
      '<div><p class="report__glabel">' + t('r.global') + '</p><p class="report__verdict verdict--' + gb + '">' + t('r.v.' + gb) + '</p>' +
      '<p class="report__passed"><strong>' + passed.length + '</strong> / ' + rep.checks.length + ' ' + t('r.passed') + '</p></div></div>' +
      '<div class="report__gauges">' + CATS.map(function (c) { return gauge(rep.categories[c].score, t('r.cat.' + c)); }).join('') + '</div></div>';

    var ttfbBand = rep.timing.ttfb < 600 ? 'good' : rep.timing.ttfb < 1500 ? 'mid' : 'bad';
    var sizeBand = rep.bytes < 120000 ? 'good' : rep.bytes < 350000 ? 'mid' : 'bad';
    html += '<div class="report__block reveal"><h3>' + t('r.facts') + '</h3><div class="metrics">' +
      fact(t('r.f.ttfb'), num(rep.timing.ttfb) + ' ms', ttfbBand) +
      fact(t('r.f.size'), num(rep.bytes / 1024, rep.bytes < 10240 ? 1 : 0) + ' KB', sizeBand) +
      fact(t('r.f.https'), isHttps ? t('r.f.yes') : t('r.f.no'), isHttps ? 'good' : 'bad') +
      fact(t('r.f.platform'), rep.platform || t('r.f.unknown'), 'na') +
      fact('HTTP', String(rep.status), rep.status < 300 ? 'good' : 'bad') + '</div></div>';

    if (rep.psi && rep.psi.metrics) {
      var M = rep.psi.metrics, names = { fcp: 'first-contentful-paint', lcp: 'largest-contentful-paint', tbt: 'total-blocking-time', cls: 'cumulative-layout-shift', si: 'speed-index' };
      html += '<div class="report__block reveal"><h3>' + t('r.google') + ' · ' + Math.round(rep.psi.score * 100) + '/100</h3><div class="metrics">' +
        Object.keys(names).filter(function (k) { return M[k]; }).map(function (k) { return fact(t('r.m.' + names[k]), M[k].display || '–', band(M[k].score), t('r.m.h.' + names[k])); }).join('') + '</div></div>';
    }

    var counts = {}; issues.forEach(function (i) { counts[i.cat] = (counts[i.cat] || 0) + 1; });
    html += '<div class="report__block reveal"><div class="issues__head"><div><h3>' + t('r.issues') + '</h3><p>' + t('r.issuesSub') + '</p></div>' +
      '<div class="tabs" role="tablist"><button role="tab" data-f="all" aria-selected="true">' + t('r.all') + ' <b>' + issues.length + '</b></button>' +
      CATS.map(function (c) { return '<button role="tab" data-f="' + c + '" aria-selected="false">' + t('r.cat.' + c) + ' <b>' + (counts[c] || 0) + '</b></button>'; }).join('') +
      '</div></div><div class="issues" id="issues"></div></div>';

    html += '<details class="report__block report__passedlist reveal"><summary><h3>' + t('r.passedTitle') + ' <b>' + passed.length + '</b></h3></summary><ul>' +
      passed.map(function (c) { return '<li><span class="okmark"></span><span>' + checkText(c, 'ok') + '</span><small>' + t('r.cat.' + c.cat) + '</small></li>'; }).join('') + '</ul></details>';

    html += '<div class="report__cta reveal"><div><h3>' + t('r.ctaTitle') + '</h3><p>' + t('r.ctaText') + '</p></div>' +
      '<a class="btn btn--white" id="reportMail" href="#">' + t('r.ctaBtn') + ' <span class="arrow">→</span></a></div>';

    var box = $('report'); box.innerHTML = html; box.hidden = false;
    renderIssues(issues); updateMail(); observe(box);

    box.querySelectorAll('[data-f]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.filter = b.getAttribute('data-f');
        box.querySelectorAll('[data-f]').forEach(function (o) { o.setAttribute('aria-selected', String(o === b)); });
        renderIssues(issues);
      });
    });
    $('printBtn').addEventListener('click', function () { box.querySelectorAll('details').forEach(function (d) { d.open = true; }); window.print(); });
    $('againBtn').addEventListener('click', function () { $('url').value = ''; scrollToForm(); });

    setTimeout(function () {
      box.querySelectorAll('.gauge__val').forEach(function (c) { c.style.strokeDashoffset = c.getAttribute('data-off'); });
      box.querySelectorAll('.gauge__num').forEach(function (n) {
        var to = +n.getAttribute('data-to'), t0 = performance.now(), dur = 1400;
        (function step(now) { var p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3); n.textContent = Math.round(to * e); if (p < 1) requestAnimationFrame(step); })(t0);
        setTimeout(function () { n.textContent = to; }, dur + 200);
      });
    }, 250);
    if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function fact(name, val, b, help) {
    return '<div class="metric metric--' + b + '"><span class="metric__dot"></span><p class="metric__name">' + esc(name) + '</p><p class="metric__val">' + esc(val) + '</p>' + (help ? '<p class="metric__help">' + esc(help) + '</p>' : '') + '</div>';
  }
  function renderIssues(all) {
    var list = all.filter(function (i) { return state.filter === 'all' || i.cat === state.filter; });
    var el = $('issues');
    if (!list.length) { el.innerHTML = '<p class="issues__none">' + t('r.none') + '</p>'; return; }
    el.innerHTML = list.map(function (c, n) {
      var sev = c.status === 'fail' ? 'bad' : 'mid';
      return '<details class="issue issue--' + sev + '" style="--i:' + Math.min(n, 12) + '">' +
        '<summary><span class="issue__sev"></span><span class="issue__title">' + checkText(c, 'ko') + '</span>' +
        '<span class="issue__cat">' + t('r.cat.' + c.cat) + '</span><span class="issue__val">' + t('r.sev.' + c.status) + '</span></summary>' +
        '<div class="issue__body"><p><strong>' + esc((window.CHECKS[lang()] || window.CHECKS.es)[c.id].t) + '.</strong> ' + checkText(c, 'fix') + '</p></div></details>';
    }).join('');
  }

  applyLang();
  setTimeout(function () { root.classList.add('loaded'); }, 60);
  if (location.hash === '#ejemplo') loadSample(true);
})();
