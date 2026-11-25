/*
 * Quiz rapido — motore agnostico.
 * Legge ../data/<percorso>.json (meta.format = "quiz") indicato da ?q=<base64url del percorso>.
 * Domande a scelta multipla o SÌ/NO, testo in streaming, riprova infinita, spiegazione dopo la risposta corretta.
 * Reset istruttore: Ctrl+Alt+Shift+X.
 */
(() => {
  'use strict';

  const STORE_PREFIX = 'rh-quiz:';
  const CODE_RE = /^[A-Za-z0-9_-]{4,400}$/;
  const PATH_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;
  const DEFAULT_POINTS = [1000, 500, 250, 100];
  const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const COLORS = ['--opt-a', '--opt-b', '--opt-c', '--opt-d', '--opt-e', '--opt-f'];
  const RETRY_MSGS = [
    'Non è corretto. Riprova!',
    'Risposta errata: rileggi con calma e riprova.',
    'Non ancora. Prova un\'altra opzione.',
    'Quasi… ma no. Riprova!',
  ];

  const $ = (s) => document.querySelector(s);
  const stageEl = $('#stage');
  let quiz, settings, state, storeKey;
  let gen = 0;       // generazione della schermata: invalida gli streaming di quelle precedenti
  let busy = false;  // evita doppi click durante le transizioni

  class Abort extends Error {}

  /* ---------------- utilità ---------------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function sleep(ms, g) {
    return new Promise((res, rej) => setTimeout(() => (g !== gen ? rej(new Abort()) : res()), ms));
  }
  const pts = () => (Array.isArray(settings.points) && settings.points.length ? settings.points : DEFAULT_POINTS);
  const pointsFor = (tries) => { const p = pts(); return p[Math.min(tries - 1, p.length - 1)]; };
  const fmtNum = (n) => n.toLocaleString('it-IT');
  function fmtTime(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function shuffle(a) {
    const r = a.slice();
    for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
    return r;
  }
  function decodeCode(code) {
    if (!code || !CODE_RE.test(code)) return null;
    try {
      let b64 = code.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const path = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      if (!PATH_RE.test(path) || path.split('/').some((p) => p === '.' || p === '..')) return null;
      return path;
    } catch (_) { return null; }
  }

  /* Testo con `codice inline`, senza animazione. */
  function rich(parent, text) {
    String(text).split('`').forEach((t, k) => {
      if (!t) return;
      parent.appendChild(k % 2 === 1 ? el('code', '', t) : document.createTextNode(t));
    });
    return parent;
  }

  /* ---------------- streaming del testo ---------------- */
  /* Il testo può contenere `codice inline` tra backtick. */
  async function stream(parent, tag, text, cls) {
    const g = gen;
    const p = el(tag, cls);
    p.classList.add('typing');
    parent.appendChild(p);
    const cps = settings.charsPerSecond || 38;
    const tick = 30;
    const per = Math.max(1, Math.round((cps * tick) / 1000));
    const parts = String(text).split('`');
    for (let k = 0; k < parts.length; k++) {
      const t = parts[k];
      if (!t) continue;
      const node = document.createTextNode('');
      if (k % 2 === 1) { const c = el('code'); c.appendChild(node); p.appendChild(c); } else p.appendChild(node);
      for (let i = 0; i < t.length; i += per) {
        node.data += t.slice(i, i + per);
        await sleep(tick, g);
      }
    }
    p.classList.remove('typing');
    return p;
  }

  async function streamCode(parent, lines, label, cls) {
    const g = gen;
    if (label) parent.appendChild(el('div', 'code-label', label));
    const box = el('div', 'code' + (cls ? ' ' + cls : ''));
    parent.appendChild(box);
    for (const line of lines) {
      box.appendChild(el('span', 'code-line', line === '' ? ' ' : line));
      await sleep(110, g);
    }
    await sleep(250, g);
  }

  /* ---------------- stato ---------------- */
  function storeGet() { try { return JSON.parse(localStorage.getItem(storeKey)); } catch (_) { return null; } }
  function save() { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch (_) { /* ignore */ } }
  const fingerprint = (q) => (q.meta.version || '') + '|' + q.questions.map((x) => x.id).join(',');
  function newState() {
    return {
      fp: fingerprint(quiz), name: '', phase: 'intro', idx: 0,
      startedAt: null, finishedAt: null, activeMs: 0, qStart: null,
      wrong: [], order: {}, results: [],
    };
  }
  const elapsed = () => state.activeMs + (state.qStart ? Date.now() - state.qStart : 0);
  const totalPoints = () => state.results.reduce((s, r) => s + r.points, 0);

  /* ---------------- intestazione ---------------- */
  function updateHeader() {
    const n = quiz.questions.length;
    $('#stats').hidden = state.phase === 'intro';
    $('#progress').textContent = `${Math.min(state.idx + 1, n)}/${n}`;
    $('#score').textContent = fmtNum(totalPoints());
    $('#timer').textContent = fmtTime(elapsed());
    $('#bar-fill').style.width = `${(state.results.length / n) * 100}%`;
  }
  setInterval(() => { if (state) $('#timer').textContent = fmtTime(elapsed()); }, 500);

  /* Nuova schermata: "pulisce" lo schermo con una dissolvenza e invalida gli streaming in corso. */
  async function newScreen() {
    gen++;
    const old = stageEl.firstElementChild;
    if (old) {
      old.classList.add('leaving');
      await new Promise((r) => setTimeout(r, 280));
    }
    stageEl.textContent = '';
    window.scrollTo(0, 0);
    const s = el('section', 'screen');
    stageEl.appendChild(s);
    updateHeader();
    return s;
  }

  function button(parent, label, onClick) {
    const row = el('div', 'actions');
    const b = el('button', 'btn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    row.appendChild(b);
    parent.appendChild(row);
    b.focus({ preventScroll: true });
    return row;
  }

  /* ---------------- schermate ---------------- */
  async function showIntro() {
    const s = await newScreen();
    const m = quiz.meta;
    const eyebrow = [m.day, m.chapters].filter(Boolean).join(' · ');
    if (eyebrow) s.appendChild(el('p', 'eyebrow', eyebrow));
    s.appendChild(el('h1', '', m.title));
    for (const line of m.intro || []) await stream(s, 'p', line, 'lead');

    const n = quiz.questions.length;
    const p = pts();
    const ul = el('ul', 'rules');
    [
      `${n} domande: scelta multipla oppure SÌ / NO.`,
      'Se sbagli, l\'opzione viene esclusa e riprovi finché non trovi quella giusta.',
      `Punti: ${p.map(fmtNum).join(' / ')} in base al tentativo con cui rispondi correttamente.`,
      'Dopo ogni risposta corretta leggi la spiegazione: è il momento del ripasso (il tempo è fermo).',
    ].forEach((t) => ul.appendChild(el('li', '', t)));
    s.appendChild(ul);

    const form = el('div', 'actions');
    const inp = el('input', 'name');
    inp.placeholder = 'Il tuo nome (facoltativo)';
    inp.maxLength = 40;
    inp.value = state.name || '';
    inp.setAttribute('aria-label', 'Il tuo nome');
    const b = el('button', 'btn', 'Inizia il quiz →');
    b.type = 'button';
    const go = () => {
      if (busy) return;
      state.name = inp.value.trim();
      state.phase = 'q';
      state.startedAt = Date.now();
      save();
      run();
    };
    b.addEventListener('click', go);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    form.append(inp, b);
    s.appendChild(form);
    inp.focus({ preventScroll: true });
  }

  function optionsFor(q) {
    if (q.type === 'yesno') return [{ id: 'si', text: 'SÌ', key: 'S' }, { id: 'no', text: 'NO', key: 'N' }];
    let ids = state.order[q.id];
    const valid = Array.isArray(ids) && ids.length === q.options.length && q.options.every((o) => ids.includes(o.id));
    if (!valid) {
      ids = settings.shuffleOptions === false ? q.options.map((o) => o.id) : shuffle(q.options.map((o) => o.id));
      state.order[q.id] = ids;
      save();
    }
    return ids.map((id, i) => ({ ...q.options.find((o) => o.id === id), key: KEYS[i] }));
  }

  async function showQuestion() {
    const s = await newScreen();
    const g = gen;
    const n = quiz.questions.length;
    const q = quiz.questions[state.idx];
    s.appendChild(el('p', 'eyebrow', `Domanda ${state.idx + 1} di ${n}` + (q.topic ? ` · ${q.topic}` : '')));
    await stream(s, 'h2', q.question);
    if (q.code) await streamCode(s, q.code);

    const opts = optionsFor(q);
    const box = el('div', 'options' + (q.type === 'yesno' ? ' yesno' : ''));
    s.appendChild(box);
    const fb = el('div', 'feedback ko');
    fb.setAttribute('role', 'status');
    const buttons = [];
    if (!state.qStart) { state.qStart = Date.now(); save(); }
    for (let i = 0; i < opts.length; i++) {
      const o = opts[i];
      const b = el('button', 'opt' + (q.type === 'yesno' ? ' big' : ''));
      b.type = 'button';
      b.dataset.id = o.id;
      b.dataset.key = o.key;
      b.style.setProperty('--c', `var(${COLORS[i % COLORS.length]})`);
      b.append(el('span', 'key', o.key), rich(el('span', 'txt'), o.text));
      if (state.wrong.includes(o.id)) { b.classList.add('wrong'); b.disabled = true; }
      b.addEventListener('click', () => answer(q, o, b, fb));
      box.appendChild(b);
      buttons.push(b);
      await sleep(140, g);
    }
    s.appendChild(fb);
    const hk = el('p', 'hint-keys', q.type === 'yesno' ? 'Tastiera: S = sì, N = no' : `Tastiera: ${opts.map((o) => o.key).join(' / ')}`);
    s.appendChild(hk);

    const first = buttons.find((b) => !b.disabled);
    if (first) first.focus({ preventScroll: true });
  }

  async function answer(q, o, b, fb) {
    if (busy || b.disabled) return;
    if (o.id === q.answer) {
      busy = true;
      const tries = state.wrong.length + 1;
      b.classList.add('right');
      document.querySelectorAll('.opt').forEach((x) => { x.disabled = true; });
      if (state.qStart) state.activeMs += Date.now() - state.qStart;
      state.qStart = null;
      state.results.push({ id: q.id, tries, points: pointsFor(tries) });
      state.phase = 'exp';
      save();
      updateHeader();
      await new Promise((r) => setTimeout(r, 750));
      busy = false;
      run();
      return;
    }
    state.wrong.push(o.id);
    save();
    b.classList.add('wrong', 'shake');
    b.disabled = true;
    fb.textContent = '✕ ' + RETRY_MSGS[(state.wrong.length - 1) % RETRY_MSGS.length];
    const next = [...document.querySelectorAll('.opt')].find((x) => !x.disabled);
    if (next) next.focus({ preventScroll: true });
  }

  async function showExplanation() {
    const s = await newScreen();
    const g = gen;
    const q = quiz.questions[state.idx];
    const r = state.results[state.results.length - 1] || { tries: 1, points: pointsFor(1) };
    const when = r.tries === 1 ? 'al primo tentativo' : `al ${r.tries}° tentativo`;
    s.appendChild(el('p', 'eyebrow ok', `✔ Risposta corretta ${when} · +${fmtNum(r.points)} punti`));
    s.appendChild(rich(el('p', 'question-recap'), q.question));

    const correct = q.type === 'yesno' ? (q.answer === 'si' ? 'SÌ' : 'NO') : q.options.find((o) => o.id === q.answer).text;
    const ab = el('div', 'answer-box');
    ab.appendChild(el('span', 'lbl', 'Risposta'));
    rich(ab, correct);
    s.appendChild(ab);
    await sleep(400, g);

    const ex = el('div', 'explain');
    s.appendChild(ex);
    for (const para of q.explanation) {
      await stream(ex, 'p', para);
      await sleep(350, g);
    }
    if (q.fix) await streamCode(s, q.fix, 'Versione corretta', 'fix');

    const last = state.idx + 1 >= quiz.questions.length;
    button(s, last ? 'Vedi il risultato →' : 'Prossima domanda →', () => {
      if (busy) return;
      state.idx++;
      state.wrong = [];
      if (state.idx >= quiz.questions.length) { state.phase = 'done'; state.finishedAt = Date.now(); } else state.phase = 'q';
      save();
      run();
    });
  }

  async function showDone() {
    const s = await newScreen();
    const n = quiz.questions.length;
    $('#progress').textContent = `${n}/${n}`;
    const first = state.results.filter((r) => r.tries === 1).length;
    s.appendChild(el('p', 'eyebrow', 'Sessione completata'));
    s.appendChild(el('h1', '', state.name ? `Ottimo lavoro, ${state.name}!` : 'Ottimo lavoro!'));

    const tiles = el('div', 'tiles');
    [['Punteggio', fmtNum(totalPoints())], ['Corrette al 1° tentativo', `${first}/${n}`], ['Tempo di risposta', fmtTime(state.activeMs)]]
      .forEach(([k, v]) => { const t = el('div', 'tile'); t.append(el('div', 'k', k), el('div', 'v', v)); tiles.appendChild(t); });
    s.appendChild(tiles);

    const dots = el('div', 'dots');
    state.results.forEach((r, i) => {
      const d = el('span', 'dot ' + (r.tries === 1 ? 't1' : r.tries === 2 ? 't2' : 't3'), String(i + 1));
      d.title = `Domanda ${i + 1}: ${r.tries === 1 ? 'primo tentativo' : r.tries + ' tentativi'}`;
      dots.appendChild(d);
    });
    s.appendChild(dots);
    const lg = el('p', 'legend');
    [['t1', 'primo tentativo'], ['t2', 'secondo'], ['t3', 'tre o più']].forEach(([c, t]) => {
      lg.append(el('span', 'sw ' + c), document.createTextNode(` ${t}   `));
    });
    s.appendChild(lg);

    const when = new Date(state.finishedAt || Date.now()).toLocaleString('it-IT');
    s.appendChild(el('p', 'legend', `${quiz.meta.title} — completato il ${when}`));
    if (quiz.meta.outro) await stream(s, 'p', quiz.meta.outro, 'lead');
  }

  function fatal(msg, details) {
    gen++;
    stageEl.textContent = '';
    const s = el('section', 'screen');
    s.appendChild(el('p', 'eyebrow', 'Attenzione'));
    const box = el('div', 'error');
    box.appendChild(el('p', '', msg));
    if (details && details.length) {
      const ul = el('ul');
      details.slice(0, 20).forEach((d) => ul.appendChild(el('li', '', d)));
      box.appendChild(ul);
    }
    s.appendChild(box);
    stageEl.appendChild(s);
  }

  function run() {
    const fn = { intro: showIntro, q: showQuestion, exp: showExplanation, done: showDone }[state.phase] || showIntro;
    fn().catch((e) => { if (!(e instanceof Abort)) console.error(e); });
  }

  /* ---------------- tastiera ---------------- */
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyX' && storeKey) {
      e.preventDefault();
      if (window.confirm('Azzerare il quiz su questo PC? Punteggio e progressi verranno cancellati.')) {
        try { localStorage.removeItem(storeKey); } catch (_) { /* ignore */ }
        location.reload();
      }
      return;
    }
    if (!state || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target && e.target.tagName === 'INPUT') return;
    if (state.phase === 'q') {
      let k = e.key.toUpperCase();
      if (/^[1-6]$/.test(k)) k = KEYS[Number(k) - 1];
      const q = quiz.questions[state.idx];
      if (q.type === 'yesno') { if (k === 'A' || k === 'Y') k = 'S'; if (k === 'B') k = 'N'; }
      const b = [...document.querySelectorAll('.opt')].find((x) => x.dataset.key === k);
      if (b) { e.preventDefault(); b.click(); }
    }
  });

  /* ---------------- avvio ---------------- */
  async function boot() {
    let data, code;
    const embedded = document.getElementById('quiz-data');
    if (embedded) {
      // Pagina autonoma generata da "node tools/quiz.mjs export": il quiz è incorporato nell'HTML.
      try { data = JSON.parse(embedded.textContent); } catch (_) { return fatal('Il quiz incorporato non è valido.'); }
      code = (data.meta && data.meta.id) || location.pathname;
    } else {
      code = new URLSearchParams(location.search).get('q');
      if (!code) return fatal('Nessun quiz indicato. Apri il link fornito dall\'istruttore.');
      const path = decodeCode(code);
      if (!path) return fatal('Link non valido. Controlla di averlo copiato per intero.');
      try {
        const res = await fetch(`../data/${path}.json`, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
      } catch (_) {
        return fatal('Quiz non trovato. Controlla di aver copiato il link completo.');
      }
      if (!window.isQuickQuiz(data)) { location.replace('../?q=' + encodeURIComponent(code)); return; }
    }
    const errs = window.validateQuiz(data);
    if (errs.length) return fatal('Il file del quiz non è valido. Avvisa l\'istruttore.', errs);

    quiz = data;
    settings = quiz.settings || {};
    const m = quiz.meta;
    document.title = m.title;
    $('#course-code').textContent = m.courseCode || 'Quiz';
    $('#course-day').textContent = m.day || '';
    $('#foot-course').textContent = m.course || '';

    storeKey = STORE_PREFIX + code;
    state = storeGet();
    if (!state || state.fp !== fingerprint(quiz)) state = newState();
    if (state.phase === 'q' && state.idx >= quiz.questions.length) state.phase = 'done';
    run();
  }

  boot();
})();
