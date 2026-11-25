/* Nucleo condiviso browser/Node: validazione schema, confronto comandi, autotest. */
(function (root) {
  'use strict';

  const isStr = (v) => typeof v === 'string' && v.trim() !== '';
  const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

  /* ---------- confronto comandi ---------- */
  function normalizeCommand(s) {
    return String(s).replace(/ /g, ' ').trim().replace(/^[$#]\s+/, '').replace(/\s+/g, ' ');
  }

  function matchCommand(spec, raw, caseSensitive) {
    const v = normalizeCommand(raw);
    const cmp = (x) => (caseSensitive ? x : x.toLowerCase());
    if ((spec.accept || []).some((a) => cmp(normalizeCommand(a)) === cmp(v))) return true;
    return (spec.acceptRegex || []).some((r) => {
      try { return new RegExp(r, caseSensitive ? '' : 'i').test(v); } catch (_) { return false; }
    });
  }

  /* Elenca i "bersagli comando" del quiz: stage command e singoli passi delle sequence. */
  function commandTargets(q) {
    const cs0 = !!(q.settings && q.settings.caseSensitive);
    const out = [];
    q.stages.forEach((s) => {
      if (s.type === 'command') {
        out.push({ where: s.id, spec: s, cs: s.caseSensitive !== undefined ? !!s.caseSensitive : cs0 });
      } else if (s.type === 'sequence') {
        s.steps.forEach((st, k) => {
          const cs = st.caseSensitive !== undefined ? !!st.caseSensitive : (s.caseSensitive !== undefined ? !!s.caseSensitive : cs0);
          out.push({ where: `${s.id} passo ${k + 1}`, spec: st, cs });
        });
      }
    });
    return out;
  }

  /* ---------- validazione schema ---------- */
  function checkCommandSpec(e, where, s) {
    const acc = s.accept;
    const rx = s.acceptRegex;
    if (acc !== undefined && !(Array.isArray(acc) && acc.every(isStr))) e.push(`${where}: "accept" deve essere un array di stringhe.`);
    if (rx !== undefined) {
      if (!(Array.isArray(rx) && rx.every(isStr))) e.push(`${where}: "acceptRegex" deve essere un array di stringhe.`);
      else rx.forEach((r) => { try { new RegExp(r); } catch (err) { e.push(`${where}: regex non valida: ${r}`); } });
    }
    if (!(Array.isArray(acc) && acc.length) && !(Array.isArray(rx) && rx.length)) {
      e.push(`${where}: serve almeno una risposta in "accept" o "acceptRegex".`);
    }
    if (s.tests !== undefined) {
      const t = s.tests;
      if (!t || typeof t !== 'object' || (t.pass !== undefined && !isStrArr(t.pass)) || (t.fail !== undefined && !isStrArr(t.fail))) {
        e.push(`${where}: "tests" deve essere { "pass": [stringhe], "fail": [stringhe] }.`);
      }
    }
  }

  function checkHints(e, where, hints) {
    if (hints === undefined) return;
    if (!Array.isArray(hints)) { e.push(`${where}: "hints" deve essere un array.`); return; }
    hints.forEach((h, j) => {
      if (!h || !isStr(h.text)) e.push(`${where}: hints[${j}].text mancante.`);
      else if (h.penaltySeconds !== undefined && !(Number.isFinite(h.penaltySeconds) && h.penaltySeconds >= 0)) {
        e.push(`${where}: hints[${j}].penaltySeconds deve essere un numero >= 0.`);
      }
    });
  }

  function checkSeconds(e, where, v) {
    if (v !== undefined && !(Number.isFinite(v) && v >= 0)) e.push(`${where} deve essere un numero >= 0.`);
  }

  /* question + options + answer (+ hints): usato da choice, flash del briefing, ipotesi del mystery */
  function checkChoice(e, where, s, min = 2) {
    checkHints(e, where, s.hints);
    if (!isStr(s.question)) e.push(`${where}: "question" mancante.`);
    if (!Array.isArray(s.options) || s.options.length < min || s.options.length > 8) {
      e.push(`${where}: "options" deve avere da ${min} a 8 elementi.`);
      return;
    }
    const oid = new Set();
    s.options.forEach((o, j) => {
      if (!o || !isStr(o.id) || !isStr(o.text)) e.push(`${where}: options[${j}] richiede "id" e "text".`);
      else if (oid.has(o.id)) e.push(`${where}: options[${j}] ha un id duplicato.`);
      else oid.add(o.id);
    });
    if (!oid.has(s.answer)) e.push(`${where}: "answer" non corrisponde a nessun id delle opzioni.`);
  }

  const MYSTERY_WORDS = ['indizi', 'caso', 'risolvi', 'indaga', 'aiuto', 'help'];

  /* ---------- formato "quiz rapido" (meta.format = "quiz"): solo scelta multipla / SÌ-NO ---------- */
  const isQuick = (q) => !!(q && q.meta && q.meta.format === 'quiz');

  function validateQuick(q) {
    const e = [];
    const m = q.meta;
    if (!isStr(m.title)) e.push('meta.title mancante.');
    if (m.intro !== undefined && !isStrArr(m.intro)) e.push('meta.intro deve essere un array di stringhe.');
    ['outro', 'courseCode', 'day', 'chapters', 'course'].forEach((k) => {
      if (m[k] !== undefined && typeof m[k] !== 'string') e.push(`meta.${k} deve essere una stringa.`);
    });
    const s = q.settings;
    if (s !== undefined) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) e.push('"settings" deve essere un oggetto.');
      else {
        if (s.points !== undefined && !(Array.isArray(s.points) && s.points.length && s.points.every((x) => Number.isFinite(x) && x >= 0))) {
          e.push('settings.points deve essere un array di numeri >= 0.');
        }
        if (s.charsPerSecond !== undefined && !(Number.isFinite(s.charsPerSecond) && s.charsPerSecond > 0)) {
          e.push('settings.charsPerSecond deve essere un numero > 0.');
        }
      }
    }
    if (!Array.isArray(q.questions) || !q.questions.length) {
      e.push('"questions" deve essere un array non vuoto.');
      return e;
    }
    const ids = new Set();
    q.questions.forEach((x, i) => {
      const where = `questions[${i}]` + (x && isStr(x.id) ? ` (${x.id})` : '');
      if (!x || typeof x !== 'object' || Array.isArray(x)) { e.push(`${where}: non è un oggetto.`); return; }
      if (!isStr(x.id)) e.push(`${where}: "id" mancante.`);
      else if (ids.has(x.id)) e.push(`${where}: "id" duplicato.`);
      else ids.add(x.id);
      if (!isStr(x.question)) e.push(`${where}: "question" mancante.`);
      if (x.topic !== undefined && typeof x.topic !== 'string') e.push(`${where}: "topic" deve essere una stringa.`);
      ['code', 'fix'].forEach((k) => {
        if (x[k] !== undefined && !(Array.isArray(x[k]) && x[k].length && isStrArr(x[k]))) e.push(`${where}: "${k}" deve essere un array non vuoto di stringhe.`);
      });
      if (!(Array.isArray(x.explanation) && x.explanation.length && x.explanation.every(isStr))) {
        e.push(`${where}: "explanation" deve essere un array non vuoto di paragrafi.`);
      }
      if (x.type === 'yesno') {
        if (x.answer !== 'si' && x.answer !== 'no') e.push(`${where}: in "yesno" "answer" deve essere "si" o "no".`);
        if (x.options !== undefined) e.push(`${where}: "yesno" non usa "options".`);
      } else if (x.type === 'choice') {
        if (!Array.isArray(x.options) || x.options.length < 2 || x.options.length > 6) {
          e.push(`${where}: "options" deve avere da 2 a 6 elementi.`);
          return;
        }
        const oid = new Set();
        x.options.forEach((o, j) => {
          if (!o || !isStr(o.id) || !isStr(o.text)) e.push(`${where}: options[${j}] richiede "id" e "text".`);
          else if (oid.has(o.id)) e.push(`${where}: options[${j}] ha un id duplicato.`);
          else oid.add(o.id);
        });
        if (!oid.has(x.answer)) e.push(`${where}: "answer" non corrisponde a nessun id delle opzioni.`);
      } else {
        e.push(`${where}: "type" deve essere "choice" o "yesno".`);
      }
    });
    return e;
  }

  /* Controlli di qualità (solo strumenti): bilanciamento SÌ/NO, spiegazioni non banali. */
  function selfTestQuick(q) {
    const e = [];
    const yn = q.questions.filter((x) => x.type === 'yesno');
    const yes = yn.filter((x) => x.answer === 'si').length;
    if (yn.length >= 4 && (yes === 0 || yes === yn.length)) e.push(`le domande SÌ/NO hanno tutte la stessa risposta ("${yn[0].answer}").`);
    q.questions.forEach((x) => {
      const len = x.explanation.join(' ').length;
      if (len < 200) e.push(`${x.id}: spiegazione troppo breve (${len} caratteri, minimo 200).`);
    });
    return e;
  }

  function validateQuiz(q) {
    const e = [];
    if (!q || typeof q !== 'object' || Array.isArray(q)) return ['La radice del JSON deve essere un oggetto.'];
    if (isQuick(q)) return validateQuick(q);

    if (!q.meta || typeof q.meta !== 'object') {
      e.push('Manca l\'oggetto "meta".');
    } else {
      if (!isStr(q.meta.title)) e.push('meta.title mancante.');
      if (q.meta.intro !== undefined && !isStrArr(q.meta.intro)) e.push('meta.intro deve essere un array di stringhe.');
      if (q.meta.outro !== undefined && typeof q.meta.outro !== 'string') e.push('meta.outro deve essere una stringa.');
    }

    if (q.settings !== undefined) {
      const s = q.settings;
      if (!s || typeof s !== 'object' || Array.isArray(s)) e.push('"settings" deve essere un oggetto.');
      else ['defaultHintPenaltySeconds', 'wrongPenaltySeconds'].forEach((k) => checkSeconds(e, 'settings.' + k, s[k]));
    }

    if (!Array.isArray(q.stages) || q.stages.length === 0) {
      e.push('"stages" deve essere un array non vuoto.');
      return e;
    }

    const ids = new Set();
    q.stages.forEach((s, i) => {
      const where = `stages[${i}]` + (s && isStr(s.id) ? ` (${s.id})` : '');
      if (!s || typeof s !== 'object' || Array.isArray(s)) { e.push(`${where}: non è un oggetto.`); return; }

      if (!isStr(s.id)) e.push(`${where}: "id" mancante.`);
      else if (ids.has(s.id)) e.push(`${where}: "id" duplicato.`);
      else ids.add(s.id);

      if (!isStr(s.title)) e.push(`${where}: "title" mancante.`);
      ['narrative', 'question', 'prompt', 'explanation'].forEach((k) => {
        if (s[k] !== undefined && typeof s[k] !== 'string') e.push(`${where}: "${k}" deve essere una stringa.`);
      });
      if (s.context !== undefined && !isStrArr(s.context)) e.push(`${where}: "context" deve essere un array di stringhe.`);

      if (s.type === 'choice') {
        checkChoice(e, where, s);
      } else if (s.type === 'briefing') {
        if (!Array.isArray(s.points) || !s.points.length || !s.points.every(isStr)) e.push(`${where}: "points" deve essere un array non vuoto di stringhe.`);
        if (s.question !== undefined || s.options !== undefined) checkChoice(e, `${where} (domanda flash)`, s);
        else if (s.hints !== undefined) e.push(`${where}: "hints" ha senso solo con una domanda flash.`);
      } else if (s.type === 'mystery') {
        checkChoice(e, `${where} (ipotesi)`, s, 3);
        checkSeconds(e, `${where}: wrongPenaltySeconds`, s.wrongPenaltySeconds);
        checkSeconds(e, `${where}: hintPenaltySeconds`, s.hintPenaltySeconds);
        if (s.hints !== undefined) e.push(`${where}: nel "mystery" il supporto L2 rivela il comando degli indizi ("solution"), non usare "hints".`);
        if (!Array.isArray(s.clues) || s.clues.length < 2 || s.clues.length > 15) {
          e.push(`${where}: "clues" deve avere da 2 a 15 indizi.`);
        } else {
          const cid = new Set();
          s.clues.forEach((c, k) => {
            const w = `${where} indizio ${k + 1}`;
            if (!c || typeof c !== 'object') { e.push(`${w}: non è un oggetto.`); return; }
            if (!isStr(c.id)) e.push(`${w}: "id" mancante.`);
            else if (cid.has(c.id)) e.push(`${w}: "id" duplicato.`);
            if (!isStr(c.label)) e.push(`${w}: "label" mancante (descrive la pista, non il comando).`);
            if (!isStr(c.solution)) e.push(`${w}: "solution" mancante (comando rivelato dal supporto L2).`);
            if (!Array.isArray(c.output) || !c.output.length || !isStrArr(c.output)) e.push(`${w}: "output" deve essere un array non vuoto di stringhe.`);
            if (c.requires !== undefined && !cid.has(c.requires)) e.push(`${w}: "requires" deve indicare l'id di un indizio PRECEDENTE.`);
            checkCommandSpec(e, w, c);
            if (isStr(c.id)) cid.add(c.id);
          });
          if (s.minClues !== undefined && !(Number.isInteger(s.minClues) && s.minClues >= 0 && s.minClues <= s.clues.length)) {
            e.push(`${where}: "minClues" deve essere un intero tra 0 e il numero di indizi.`);
          }
        }
      } else if (s.type === 'command') {
        checkHints(e, where, s.hints);
        checkCommandSpec(e, where, s);
      } else if (s.type === 'sequence') {
        if (s.hints !== undefined) e.push(`${where}: in una "sequence" gli hints vanno dentro ogni passo (steps[].hints).`);
        if (!Array.isArray(s.steps) || s.steps.length < 1 || s.steps.length > 10) {
          e.push(`${where}: "steps" deve avere da 1 a 10 passi.`);
        } else {
          s.steps.forEach((st, k) => {
            const w = `${where} passo ${k + 1}`;
            if (!st || typeof st !== 'object') { e.push(`${w}: non è un oggetto.`); return; }
            if (!isStr(st.instruction)) e.push(`${w}: "instruction" mancante.`);
            if (st.prompt !== undefined && typeof st.prompt !== 'string') e.push(`${w}: "prompt" deve essere una stringa.`);
            if (st.output !== undefined && !isStrArr(st.output)) e.push(`${w}: "output" deve essere un array di stringhe.`);
            checkHints(e, w, st.hints);
            checkCommandSpec(e, w, st);
          });
        }
      } else {
        e.push(`${where}: "type" deve essere "choice", "command", "sequence", "briefing" o "mystery".`);
      }
    });

    return e;
  }

  /* ---------- autotest (solo strumenti: tools/quiz.mjs) ----------
   * Per ogni comando: i "tests.pass" devono essere accettati, i "tests.fail" rifiutati,
   * e il comando scritto dopo "SOLUZIONE:" nell'ultimo hint deve essere accettato. */
  function selfTestQuiz(q) {
    if (isQuick(q)) return selfTestQuick(q);
    const e = [];
    commandTargets(q).forEach(({ where, spec, cs }) => {
      const t = spec.tests || {};
      (t.pass || []).forEach((x) => { if (!matchCommand(spec, x, cs)) e.push(`${where}: dovrebbe accettare  ${x}`); });
      (t.fail || []).forEach((x) => { if (matchCommand(spec, x, cs)) e.push(`${where}: NON dovrebbe accettare  ${x}`); });
      (spec.hints || []).forEach((h) => {
        const m = /^\s*SOLUZIONE:\s*(.+)$/i.exec(h.text || '');
        if (m && !matchCommand(spec, m[1], cs)) e.push(`${where}: la SOLUZIONE dell'hint non viene accettata  ${m[1]}`);
      });
      if (!(spec.hints || []).some((h) => /^\s*SOLUZIONE:/i.test(h.text || ''))) {
        e.push(`${where}: manca un hint finale "SOLUZIONE: ..." (lo studente potrebbe bloccarsi).`);
      }
    });
    const cs0 = !!(q.settings && q.settings.caseSensitive);
    q.stages.filter((s) => s.type === 'mystery').forEach((s) => {
      s.clues.forEach((c, k) => {
        const where = `${s.id} indizio "${c.id}"`;
        const cs = c.caseSensitive !== undefined ? !!c.caseSensitive : cs0;
        const t = c.tests || {};
        (t.pass || []).forEach((x) => { if (!matchCommand(c, x, cs)) e.push(`${where}: dovrebbe accettare  ${x}`); });
        (t.fail || []).forEach((x) => { if (matchCommand(c, x, cs)) e.push(`${where}: NON dovrebbe accettare  ${x}`); });
        if (!matchCommand(c, c.solution, cs)) e.push(`${where}: "solution" non viene accettata  ${c.solution}`);
        // il motore usa il primo indizio che corrisponde: la soluzione non deve essere "rubata" da un indizio precedente
        const first = s.clues.find((o) => matchCommand(o, c.solution, o.caseSensitive !== undefined ? !!o.caseSensitive : cs0));
        if (first && first !== c) e.push(`${where}: "solution" viene intercettata dall'indizio "${first.id}"`);
        MYSTERY_WORDS.forEach((w) => { if (matchCommand(c, w, false)) e.push(`${where}: accetta la parola riservata "${w}"`); });
      });
    });
    return e;
  }

  const api = { validateQuiz, matchCommand, normalizeCommand, selfTestQuiz, isQuickQuiz: isQuick };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
