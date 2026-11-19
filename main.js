(function () {
  'use strict';

  var root = document.documentElement;
  var CFG = window.AUDIT_CONFIG || {};
  var CATS = ['performance', 'seo', 'accessibility', 'best-practices'];
  var METRICS = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index'];
  var SCORED = { numeric: 1, binary: 1, metricSavings: 1 };

  var state = { lhr: null, sample: false, filter: 'all', running: false };

  function $(id) { return document.getElementById(id); }
  function lang() { return root.getAttribute('lang') === 'ca' ? 'ca' : 'es'; }
  function t(k) { var d = window.I18N[lang()]; return d[k] != null ? d[k] : window.I18N.es[k]; }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function md(s) {
    return esc(s)
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function band(score) { return score == null ? 'na' : score >= 0.9 ? 'good' : score >= 0.5 ? 'mid' : 'bad'; }

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
      root.setAttribute('lang', l);
      save('codelab-lang', l);
      applyLang();
      if (state.lhr) {
        if (state.sample) loadSample(false);
        else renderReport(state.lhr, false);
      }
      document.body.classList.remove('lang-switching');
    }, 220);
  }
  document.querySelectorAll('[data-lang]').forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.getAttribute('data-lang')); });
  });

  /* =================== Tema, menú, cabecera =================== */
  $('themeToggle').addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.classList.add('theme-anim');
    root.setAttribute('data-theme', next);
    save('codelab-theme', next);
    setTimeout(function () { root.classList.remove('theme-anim'); }, 600);
  });
  var toggle = document.querySelector('.nav__toggle');
  toggle.addEventListener('click', function () {
    var open = document.body.classList.toggle('menu-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('.nav__links a').forEach(function (a) {
    a.addEventListener('click', function () { document.body.classList.remove('menu-open'); toggle.setAttribute('aria-expanded', 'false'); });
  });
  var nav = $('nav');
  var onScroll = function () { nav.classList.toggle('nav--scrolled', window.scrollY > 10); };
  onScroll(); window.addEventListener('scroll', onScroll, { passive: true });

  /* =================== Animaciones de entrada =================== */
  root.classList.add('js');
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }) : null;
  function observe(scope) {
    (scope || document).querySelectorAll('.reveal:not(.in)').forEach(function (el) { io ? io.observe(el) : el.classList.add('in'); });
  }
  observe();

  var faq = document.querySelectorAll('.faq details');
  faq.forEach(function (d) { d.addEventListener('toggle', function () { if (d.open) faq.forEach(function (o) { if (o !== d) o.open = false; }); }); });

  /* =================== Correo =================== */
  var chosenService = null;
  function mailto(extra) {
    var lines = [t('mail.hello'), ''];
    if (chosenService) lines.push(t('mail.service') + ': ' + t(chosenService));
    if (state.lhr && !state.sample) {
      var r = state.lhr;
      lines.push(t('mail.web') + ': ' + r.finalDisplayedUrl);
      lines.push('', t('mail.scores') + ' (' + t(r.configSettings.formFactor === 'desktop' ? 'r.desktop' : 'r.mobile') + '):');
      CATS.forEach(function (c) { if (r.categories[c]) lines.push('· ' + t('r.cat.' + c) + ': ' + Math.round(r.categories[c].score * 100) + '/100'); });
    } else {
      lines.push(t('mail.web') + ': ');
    }
    if (extra) lines.push('', extra);
    return 'mailto:' + (CFG.email || '') + '?subject=' + encodeURIComponent('Codelab · ' + t('mail.subject')) + '&body=' + encodeURIComponent(lines.join('\n'));
  }
  function updateMail() {
    var m = $('ctaMail'); if (m) m.href = mailto();
    var r = $('reportMail'); if (r) r.href = mailto();
  }
  document.querySelectorAll('[data-service]').forEach(function (b) {
    b.addEventListener('click', function () { chosenService = b.getAttribute('data-service'); updateMail(); });
  });
  updateMail();

  /* =================== Formulario =================== */
  function normalizeUrl(raw) {
    var v = (raw || '').trim();
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
      var u = new URL(v);
      if (!/\./.test(u.hostname) || /\s/.test(v)) return null;
      return u.href;
    } catch (e) { return null; }
  }
  function showError(msg) {
    var e = $('formError');
    if (!msg) { e.hidden = true; e.textContent = ''; return; }
    e.textContent = msg; e.hidden = false;
  }

  $('scanForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (state.running) return;
    var url = normalizeUrl($('url').value);
    if (!url) { showError(t('err.url')); $('url').focus(); return; }
    showError(null);
    var device = (document.querySelector('input[name="device"]:checked') || {}).value || 'mobile';
    analyze(url, device);
  });
  $('sampleBtn').addEventListener('click', function () { showError(null); loadSample(true); });

  /* =================== Progreso =================== */
  var progTimer = null;
  function startProgress(url) {
    var steps = t('p.steps');
    $('progressUrl').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    $('progressList').innerHTML = steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    $('progressStep').textContent = t('p.wait');
    $('report').hidden = true;
    $('progress').hidden = false;
    var items = $('progressList').children, i = 0, start = Date.now();
    items[0].classList.add('active');
    progTimer = setInterval(function () {
      var s = (Date.now() - start) / 1000;
      $('progressBar').style.width = (92 * (1 - Math.exp(-s / 14))).toFixed(1) + '%';
      var target = Math.min(items.length - 1, Math.floor(s / 6));
      while (i < target) { items[i].classList.remove('active'); items[i].classList.add('done'); i++; items[i].classList.add('active'); }
    }, 200);
    $('progress').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function stopProgress() {
    clearInterval(progTimer);
    $('progressBar').style.width = '100%';
    $('progress').hidden = true;
    $('progressBar').style.width = '0';
  }

  /* =================== Análisis =================== */
  function analyze(url, device) {
    state.running = true;
    $('scanBtn').disabled = true;
    startProgress(url);

    var p = new URLSearchParams();
    p.set('url', url);
    p.set('strategy', device);
    p.set('locale', lang());
    ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO'].forEach(function (c) { p.append('category', c); });
    if (CFG.apiKey) p.set('key', CFG.apiKey);

    var ctrl = 'AbortController' in window ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 120000);

    fetch('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + p.toString(), ctrl ? { signal: ctrl.signal } : {})
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
      })
      .then(function (r) {
        if (r.ok && r.body.lighthouseResult) {
          stopProgress();
          renderReport(r.body.lighthouseResult, true);
          return;
        }
        var msg = (r.body.error && r.body.error.message) || '';
        stopProgress();
        if (r.status === 429 || r.status === 403 || /quota|API key|unregistered callers/i.test(msg)) {
          showError(t('err.quota'));
          loadSample(true);
        } else {
          showError(t('err.fetch'));
          scrollToForm();
        }
      })
      .catch(function () {
        stopProgress();
        showError(t('err.network'));
        scrollToForm();
      })
      .then(function () {
        clearTimeout(to);
        state.running = false;
        $('scanBtn').disabled = false;
      });
  }

  function loadSample(scroll) {
    fetch('data/ejemplo-' + lang() + '.json')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.sample = true;
        renderReport(d.lighthouseResult, scroll, true);
      })
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
      '<span class="gauge__num" data-to="' + pct + '">0</span>' +
      (label ? '<span class="gauge__label">' + esc(label) + '</span>' : '') + '</div>';
  }

  function collect(lhr) {
    var seen = {}, issues = [], passed = {};
    CATS.forEach(function (cat) {
      var c = lhr.categories[cat]; if (!c) return;
      passed[cat] = 0;
      c.auditRefs.forEach(function (ref) {
        if (ref.group === 'hidden' || ref.group === 'metrics') return;
        var a = lhr.audits[ref.id];
        if (!a || !SCORED[a.scoreDisplayMode] || a.score == null) return;
        if (a.score >= 0.9) { passed[cat]++; return; }
        if (seen[ref.id]) return;
        seen[ref.id] = 1;
        issues.push({
          cat: cat, a: a, weight: ref.weight || 0,
          save: (a.details && a.details.overallSavingsMs) || 0
        });
      });
    });
    issues.sort(function (x, y) {
      return (y.weight - x.weight) || (y.save - x.save) || (x.a.score - y.a.score);
    });
    return { issues: issues, passed: passed };
  }

  function renderReport(lhr, scroll, isSample) {
    state.lhr = lhr;
    state.sample = !!isSample;
    state.filter = 'all';
    var data = collect(lhr);
    var scores = CATS.filter(function (c) { return lhr.categories[c]; }).map(function (c) { return lhr.categories[c].score || 0; });
    var global = scores.reduce(function (a, b) { return a + b; }, 0) / (scores.length || 1);
    var gb = band(global);
    var host = lhr.finalDisplayedUrl || '';
    var when = new Date(lhr.fetchTime || Date.now());
    var dateStr = when.toLocaleDateString(lang() === 'ca' ? 'ca-ES' : 'es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    var device = lhr.configSettings && lhr.configSettings.formFactor === 'desktop' ? 'r.desktop' : 'r.mobile';
    var totalPassed = Object.keys(data.passed).reduce(function (a, k) { return a + data.passed[k]; }, 0);

    var html = '';
    if (state.sample) html += '<div class="report__sample reveal"><strong>' + t('r.sample') + '</strong> · ' + t('r.sampleNote') + '</div>';

    html += '<header class="report__head reveal">' +
      '<div class="report__id"><p class="kicker">' + t('r.title') + '</p>' +
      '<h2><a href="' + esc(host) + '" target="_blank" rel="noopener">' + esc(host.replace(/^https?:\/\//, '').replace(/\/$/, '')) + '</a></h2>' +
      '<p class="report__meta"><span class="pill">' + t(device) + '</span> ' + t('r.date') + ' ' + esc(dateStr) + '</p></div>' +
      '<div class="report__actions"><button type="button" class="btn btn--ghost btn--sm" id="printBtn">' + t('r.print') + '</button>' +
      '<button type="button" class="btn btn--ghost btn--sm" id="againBtn">' + t('r.again') + '</button></div></header>';

    html += '<div class="report__summary reveal">' +
      '<div class="report__global">' + gauge(global, null, true) +
      '<div><p class="report__glabel">' + t('r.global') + '</p><p class="report__verdict verdict--' + gb + '">' + t('r.v.' + gb) + '</p>' +
      '<p class="report__passed"><strong>' + totalPassed + '</strong> ' + t('r.passed') + '</p></div></div>' +
      '<div class="report__gauges">' + CATS.filter(function (c) { return lhr.categories[c]; }).map(function (c) { return gauge(lhr.categories[c].score, t('r.cat.' + c)); }).join('') + '</div></div>';

    if (lhr.categories.performance) {
      html += '<div class="report__block reveal"><h3>' + t('r.metrics') + '</h3><div class="metrics">' +
        METRICS.filter(function (m) { return lhr.audits[m]; }).map(function (m) {
          var a = lhr.audits[m];
          return '<div class="metric metric--' + band(a.score) + '"><span class="metric__dot"></span>' +
            '<p class="metric__name">' + t('r.m.' + m) + '</p><p class="metric__val">' + esc(a.displayValue || '–') + '</p>' +
            '<p class="metric__help">' + t('r.m.h.' + m) + '</p></div>';
        }).join('') + '</div></div>';
    }

    var counts = {}; data.issues.forEach(function (i) { counts[i.cat] = (counts[i.cat] || 0) + 1; });
    html += '<div class="report__block reveal"><div class="issues__head"><div><h3>' + t('r.issues') + '</h3><p>' + t('r.issuesSub') + '</p></div>' +
      '<div class="tabs" role="tablist">' +
      '<button role="tab" data-f="all" aria-selected="true">' + t('r.all') + ' <b>' + data.issues.length + '</b></button>' +
      CATS.filter(function (c) { return lhr.categories[c]; }).map(function (c) { return '<button role="tab" data-f="' + c + '" aria-selected="false">' + t('r.cat.' + c) + ' <b>' + (counts[c] || 0) + '</b></button>'; }).join('') +
      '</div></div><div class="issues" id="issues"></div></div>';

    html += '<div class="report__cta reveal"><div><h3>' + t('r.ctaTitle') + '</h3><p>' + t('r.ctaText') + '</p></div>' +
      '<a class="btn btn--white" id="reportMail" href="#">' + t('r.ctaBtn') + ' <span class="arrow">→</span></a></div>';

    var box = $('report');
    box.innerHTML = html;
    box.hidden = false;
    renderIssues(data.issues);
    updateMail();
    observe(box);

    box.querySelectorAll('[data-f]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.filter = b.getAttribute('data-f');
        box.querySelectorAll('[data-f]').forEach(function (o) { o.setAttribute('aria-selected', String(o === b)); });
        renderIssues(data.issues);
      });
    });
    $('printBtn').addEventListener('click', function () {
      box.querySelectorAll('.issue').forEach(function (d) { d.open = true; });
      window.print();
    });
    $('againBtn').addEventListener('click', function () { $('url').value = ''; scrollToForm(); });

    // Animar marcadores
    setTimeout(function () {
      box.querySelectorAll('.gauge__val').forEach(function (c) { c.style.strokeDashoffset = c.getAttribute('data-off'); });
      box.querySelectorAll('.gauge__num').forEach(function (n) {
        var to = +n.getAttribute('data-to'), t0 = performance.now(), dur = 1400;
        (function step(now) {
          var p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
          n.textContent = Math.round(to * e);
          if (p < 1) requestAnimationFrame(step);
        })(t0);
        setTimeout(function () { n.textContent = to; }, dur + 200);
      });
    }, 250);

    if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderIssues(all) {
    var list = all.filter(function (i) { return state.filter === 'all' || i.cat === state.filter; });
    var el = $('issues');
    if (!list.length) { el.innerHTML = '<p class="issues__none">' + t('r.none') + '</p>'; return; }
    el.innerHTML = list.map(function (i, n) {
      var a = i.a;
      var extra = i.save >= 100 ? '<span class="issue__save">' + t('r.save') + ': ' + (i.save >= 1000 ? (i.save / 1000).toFixed(1).replace('.', lang() === 'es' || lang() === 'ca' ? ',' : '.') + ' s' : Math.round(i.save) + ' ms') + '</span>'
        : (a.displayValue ? '<span class="issue__val">' + esc(a.displayValue) + '</span>' : '');
      return '<details class="issue issue--' + band(a.score) + '" style="--i:' + Math.min(n, 12) + '">' +
        '<summary><span class="issue__sev"></span><span class="issue__title">' + md(a.title) + '</span>' +
        '<span class="issue__cat">' + t('r.cat.' + i.cat) + '</span>' + extra + '</summary>' +
        '<div class="issue__body">' + md(a.description || '') + '</div></details>';
    }).join('');
  }

  applyLang();
  setTimeout(function () { root.classList.add('loaded'); }, 60);
  // Enlace directo al informe de ejemplo: .../#ejemplo
  if (location.hash === '#ejemplo') loadSample(true);
})();
