/* ═══════════════════════════════════════════════════════
   Study AI — Features (Test, Flashcards, Analytics, UX)
   ═══════════════════════════════════════════════════════ */
const Features = (() => {
    'use strict';
    const { $, $$, uid, escHtml, truncate, Store, allChapters, subjects,
        currentSubjectId, currentChapterId, currentChapter, persist,
        Router, openModal, openConfirm, openSubject, renderSubjects, views } = App;

    let testState = null;
    let timerInterval = null;
    let timerSeconds = 0;

    // ══════════════════ DIFF ENGINE ══════════════════
    function tokenize(t) { return t.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean); }
    function lcsTable(a, b) {
        const m = a.length, n = b.length, dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
        for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
            dp[i][j] = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
        return dp;
    }
    function diffAnswers(correct, user) {
        const a = tokenize(correct), b = tokenize(user), dp = lcsTable(a, b);
        const raw = []; let i = a.length, j = b.length;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) { raw.push({ type: 'equal', word: a[i - 1] }); i--; j--; }
            else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { raw.push({ type: 'extra', got: b[j - 1] }); j--; }
            else { raw.push({ type: 'missing', expected: a[i - 1] }); i--; }
        }
        raw.reverse();
        const merged = []; let k = 0;
        while (k < raw.length) {
            if (raw[k].type === 'missing' && k + 1 < raw.length && raw[k + 1].type === 'extra') { merged.push({ type: 'incorrect', expected: raw[k].expected, got: raw[k + 1].got }); k += 2; }
            else if (raw[k].type === 'extra' && k + 1 < raw.length && raw[k + 1].type === 'missing') { merged.push({ type: 'incorrect', expected: raw[k + 1].expected, got: raw[k].got }); k += 2; }
            else { merged.push(raw[k]); k++; }
        }
        const eq = merged.filter(o => o.type === 'equal').length;
        return { ops: merged, score: a.length === 0 ? 1 : eq / a.length };
    }
    function renderDiff(ops) {
        let h = '<div style="line-height:2.4">';
        ops.forEach(op => {
            if (op.type === 'equal') h += `<span class="diff-correct">${escHtml(op.word)} </span>`;
            else if (op.type === 'incorrect') h += `<span class="diff-incorrect">${escHtml(op.got)}</span><span class="diff-expected"> → ${escHtml(op.expected)} </span>`;
            else if (op.type === 'missing') h += `<span class="diff-missing">${escHtml(op.expected)} </span>`;
            else if (op.type === 'extra') h += `<span class="diff-incorrect">${escHtml(op.got)} </span>`;
        });
        h += '</div><div style="margin-top:14px;font-size:.72rem;color:var(--text-dim);display:flex;flex-wrap:wrap;gap:14px">';
        h += '<span><span class="diff-correct">●</span> Correct</span><span><span style="color:var(--danger)">●</span> Incorrect</span><span><span style="color:var(--warning)">●</span> Missing</span></div>';
        return h;
    }

    // ══════════════════ FILL-IN-THE-BLANKS ══════════════════
    const STOP_WORDS = new Set('the a an is am are was were be been being have has had do does did will would shall should may might can could of in to for on with at by from as into about between through after before above below and or but nor not so yet both either neither each every all any few more most other some such no only very'.split(' '));
    function generateBlanks(text) {
        const words = tokenize(text);
        const candidates = words.map((w, i) => ({ w, i, len: w.length })).filter(x => !STOP_WORDS.has(x.w.toLowerCase()) && x.len > 3);
        candidates.sort((a, b) => b.len - a.len);
        const picks = candidates.slice(0, Math.max(1, Math.min(3, Math.ceil(candidates.length / 3))));
        picks.sort((a, b) => a.i - b.i);
        const blankedIndices = new Map(picks.map((p, n) => [p.i, n + 1]));
        const display = words.map((w, i) => blankedIndices.has(i) ? `(${blankedIndices.get(i)})____` : w).join(' ');
        const answers = picks.map((p, n) => ({ index: p.i, word: p.w, blankNum: n + 1 }));
        return { display, answers, original: text };
    }

    // ══════════════════ SPACED REPETITION (SM-2) ══════════════════
    function getSRData(itemId) { const d = Store.srData(); return d[itemId] || { ef: 2.5, interval: 1, reps: 0, nextReview: 0 }; }
    function updateSR(itemId, quality) {
        const d = Store.srData(); const sr = d[itemId] || { ef: 2.5, interval: 1, reps: 0, nextReview: 0 };
        if (quality >= 3) {
            sr.reps++;
            if (sr.reps === 1) sr.interval = 1; else if (sr.reps === 2) sr.interval = 6; else sr.interval = Math.round(sr.interval * sr.ef);
        } else { sr.reps = 0; sr.interval = 1; }
        sr.ef = Math.max(1.3, sr.ef + 0.1 - ((5 - quality) * (0.08 + (5 - quality) * 0.02)));
        sr.nextReview = Date.now() + sr.interval * 86400000;
        d[itemId] = sr; Store.saveSR(d);
    }
    function getDueItems() {
        const now = Date.now(), sr = Store.srData(), due = [];
        allChapters().forEach(ch => {
            ch.definitions.forEach(d => { const s = sr[d.id]; if (!s || s.nextReview <= now) due.push({ chId: ch.id, chName: ch.name, subName: ch.subjectName, type: 'definition', prompt: d.term, answer: d.definition, itemId: d.id }); });
            ch.qa.forEach(q => { const s = sr[q.id]; if (!s || s.nextReview <= now) due.push({ chId: ch.id, chName: ch.name, subName: ch.subjectName, type: 'qa', prompt: q.question, answer: q.answer, itemId: q.id }); });
        });
        return due;
    }

    function updateDueBanner() {
        const due = getDueItems(), banner = $('#due-review-banner'), count = $('#due-review-count');
        if (due.length > 0) { banner.classList.remove('hidden'); count.textContent = `📅 ${due.length} item${due.length > 1 ? 's' : ''} due for review`; }
        else banner.classList.add('hidden');
    }

    $('#btn-review-due').addEventListener('click', () => {
        const items = getDueItems(); if (!items.length) { alert('Nothing due!'); return; }
        testState = { items, index: 0, scores: [], mode: 'written', timerPerQ: 0, startTime: Date.now() };
        Router.go('testRunner', 'Review'); showTestQuestion();
    });

    // ══════════════════ TEST SETUP ══════════════════
    $('#btn-test-nav').addEventListener('click', () => {
        if (!allChapters().length) { alert('Add at least one chapter first.'); return; }
        Router.go('testSetup', 'Test Setup'); populateTestSetup();
    });
    $('#test-scope-select').addEventListener('change', onScopeChange);

    function populateTestSetup() {
        const box = $('#test-chapter-checkboxes'); box.innerHTML = '';
        const all = document.createElement('label'); all.className = 'chapter-checkbox-item';
        all.innerHTML = `<input type="checkbox" id="chk-all" checked> <strong>Select All</strong>`;
        box.appendChild(all);
        // Group by subjects
        subjects().forEach(sub => {
            const subHeader = document.createElement('div'); subHeader.className = 'test-subject-header';
            subHeader.innerHTML = `<span class="test-subject-dot" style="background:${sub.color}"></span> ${escHtml(sub.name)}`;
            box.appendChild(subHeader);
            sub.chapters.forEach(ch => {
                const lbl = document.createElement('label'); lbl.className = 'chapter-checkbox-item';
                lbl.innerHTML = `<input type="checkbox" class="chk-ch" value="${ch.id}" checked> Ch ${escHtml(String(ch.number))} — ${escHtml(ch.name)}`;
                box.appendChild(lbl);
            });
        });
        $('#chk-all').addEventListener('change', e => $$('.chk-ch').forEach(c => c.checked = e.target.checked));
        $$('.chk-ch').forEach(c => c.addEventListener('change', () => { $('#chk-all').checked = $$('.chk-ch').every(x => x.checked); }));
        onScopeChange();
    }

    function getSelectedChapterIds() { return $$('.chk-ch:checked').map(c => c.value); }

    function onScopeChange() {
        const scope = $('#test-scope-select').value;
        $('#specific-item-picker').classList.toggle('hidden', scope !== 'specific');
        if (scope === 'specific') populateSpecific();
    }

    function populateSpecific() {
        const ids = getSelectedChapterIds(), sel = $('#test-item-select'); sel.innerHTML = '';
        const chs = allChapters();
        ids.forEach(id => {
            const ch = chs.find(c => c.id === id); if (!ch) return;
            ch.definitions.forEach(d => { const o = document.createElement('option'); o.value = `def:${d.id}:${ch.id}`; o.textContent = `[Def] ${truncate(d.term, 40)}`; sel.appendChild(o); });
            ch.qa.forEach(q => { const o = document.createElement('option'); o.value = `qa:${q.id}:${ch.id}`; o.textContent = `[Q&A] ${truncate(q.question, 40)}`; sel.appendChild(o); });
        });
    }

    $('#btn-start-test').addEventListener('click', () => {
        const ids = getSelectedChapterIds(); if (!ids.length) { alert('Select at least one chapter.'); return; }
        const scope = $('#test-scope-select').value, mode = $('#test-mode-select').value;
        const timerPerQ = parseInt($('#test-timer-select').value) || 0;
        const chs = allChapters();
        let items = [];
        if (scope === 'due') {
            items = getDueItems();
        } else if (scope === 'specific') {
            const val = $('#test-item-select').value; if (!val) { alert('Pick an item.'); return; }
            const [t, itemId, chId] = val.split(':'); const ch = chs.find(c => c.id === chId); if (!ch) return;
            if (t === 'def') { const d = ch.definitions.find(x => x.id === itemId); if (d) items = [{ chId: ch.id, chName: ch.name, subName: ch.subjectName, type: 'definition', prompt: d.term, answer: d.definition, itemId: d.id }]; }
            else { const q = ch.qa.find(x => x.id === itemId); if (q) items = [{ chId: ch.id, chName: ch.name, subName: ch.subjectName, type: 'qa', prompt: q.question, answer: q.answer, itemId: q.id }]; }
        } else {
            ids.forEach(id => {
                const ch = chs.find(c => c.id === id); if (!ch) return;
                if (scope === 'all-qa' || scope === 'all') ch.qa.forEach(q => items.push({ chId: ch.id, chName: ch.name, subName: ch.subjectName, type: 'qa', prompt: q.question, answer: q.answer, itemId: q.id }));
                if (scope === 'all-def' || scope === 'all') ch.definitions.forEach(d => items.push({ chId: ch.id, chName: ch.name, subName: ch.subjectName, type: 'definition', prompt: d.term, answer: d.definition, itemId: d.id }));
            });
        }
        if (!items.length) { alert('No items to test.'); return; }
        for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[items[i], items[j]] = [items[j], items[i]]; }
        if (mode === 'blanks') items.forEach(it => { const b = generateBlanks(it.answer); it.blanksDisplay = b.display; it.blanksAnswers = b.answers; });

        testState = { items, index: 0, scores: [], mode, timerPerQ, startTime: Date.now() };
        if (mode === 'flashcard') { Router.go('flashcard', 'Flashcards'); showFlashcard(); }
        else { Router.go('testRunner', 'Test'); showTestQuestion(); }
    });

    function testSingleItem(type, id) {
        const ch = currentChapter(); if (!ch) return;
        const sub = App.currentSubject();
        let items = [];
        if (type === 'definition') { const d = ch.definitions.find(x => x.id === id); if (d) items = [{ chId: ch.id, chName: ch.name, subName: sub?.name, type: 'definition', prompt: d.term, answer: d.definition, itemId: d.id }]; }
        else { const q = ch.qa.find(x => x.id === id); if (q) items = [{ chId: ch.id, chName: ch.name, subName: sub?.name, type: 'qa', prompt: q.question, answer: q.answer, itemId: q.id }]; }
        if (!items.length) return;
        testState = { items, index: 0, scores: [], mode: 'written', timerPerQ: 0, startTime: Date.now() };
        Router.go('testRunner', 'Test'); showTestQuestion();
    }

    // ══════════════════ TEST RUNNER ══════════════════
    function showTestQuestion() {
        const { items, index, mode, timerPerQ } = testState; const item = items[index], total = items.length;
        $('#test-progress-text').textContent = `Question ${index + 1} / ${total}`;
        $('#test-progress-fill').style.width = `${(index / total) * 100}%`;
        const prompt = $('#test-prompt'); prompt.classList.remove('hidden');
        const chLabel = item.chName ? `<div class="prompt-chapter">${escHtml((item.subName ? item.subName + ' → ' : '') + item.chName)}</div>` : '';
        if (mode === 'blanks' && item.blanksDisplay) {
            prompt.innerHTML = `${chLabel}<span class="prompt-label">Fill in the blanks</span>${escHtml(item.blanksDisplay)}<div style="margin-top:10px;font-size:.72rem;color:var(--text-dim)">Type answers separated by commas: (1), (2), …</div>`;
        } else {
            prompt.innerHTML = `${chLabel}<span class="prompt-label">${item.type === 'definition' ? 'Define' : 'Question'}</span>${escHtml(item.prompt)}`;
        }
        $('#test-answer-input').value = ''; $('#test-answer-input').classList.remove('hidden'); $('#test-answer-input').focus();
        $('#test-result').classList.add('hidden'); $('#test-summary').classList.add('hidden');
        $('#btn-check-answer').classList.remove('hidden');
        clearInterval(timerInterval);
        if (timerPerQ > 0) {
            timerSeconds = timerPerQ; $('#test-timer-display').classList.remove('hidden'); $('#timer-bar').classList.remove('hidden');
            updateTimerDisplay();
            timerInterval = setInterval(() => {
                timerSeconds--; updateTimerDisplay();
                if (timerSeconds <= 0) { clearInterval(timerInterval); checkAnswer(true); }
            }, 1000);
        } else { $('#test-timer-display').classList.add('hidden'); $('#timer-bar').classList.add('hidden'); }
    }

    function updateTimerDisplay() {
        const el = $('#test-timer-display'), fill = $('#timer-bar-fill');
        el.textContent = timerSeconds + 's';
        el.classList.toggle('urgent', timerSeconds <= 5);
        const pct = (timerSeconds / testState.timerPerQ) * 100;
        fill.style.width = pct + '%';
        fill.className = 'timer-bar-fill' + (pct < 30 ? ' low' : pct < 60 ? ' mid' : '');
    }

    $('#btn-check-answer').addEventListener('click', () => checkAnswer(false));
    $('#test-answer-input').addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') checkAnswer(false); });

    function checkAnswer(timedOut) {
        clearInterval(timerInterval);
        const { items, index, mode } = testState; const item = items[index];
        const userAnswer = timedOut ? '' : $('#test-answer-input').value.trim();
        if (!timedOut && !userAnswer) { $('#test-answer-input').style.borderColor = 'var(--danger)'; setTimeout(() => $('#test-answer-input').style.borderColor = '', 600); return; }

        let result;
        if (mode === 'blanks' && item.blanksAnswers) {
            let userParts;
            if (userAnswer.includes(',')) {
                userParts = userAnswer.split(',').map(s => s.trim()).filter(Boolean);
            } else {
                userParts = userAnswer.split(/\s+/).filter(Boolean);
            }
            let correct = 0; const ops = [];
            item.blanksAnswers.forEach((b, bi) => {
                const uw = (userParts[bi] || '').trim();
                if (uw.toLowerCase() === b.word.toLowerCase()) { ops.push({ type: 'equal', word: `(${b.blankNum}) ${b.word}` }); correct++; }
                else if (uw) ops.push({ type: 'incorrect', expected: `(${b.blankNum}) ${b.word}`, got: uw });
                else ops.push({ type: 'missing', expected: `(${b.blankNum}) ${b.word}` });
            });
            result = { ops, score: item.blanksAnswers.length ? correct / item.blanksAnswers.length : 1 };
        } else {
            result = diffAnswers(item.answer, userAnswer);
        }
        testState.scores.push(result.score);
        if (item.itemId) { const q = Math.round(result.score * 5); updateSR(item.itemId, q); }

        // If not perfect, re-queue the item to the end so it repeats until correct
        if (result.score < 1) {
            items.push({ ...item });
        }

        const scoreEl = $('#result-score'), pct = Math.round(result.score * 100);
        scoreEl.textContent = pct === 100 ? '✅ Perfect!' : `${pct}% Match — you'll see this again`;
        scoreEl.className = 'result-score ' + (pct === 100 ? 'perfect' : pct >= 75 ? 'good' : pct >= 40 ? 'mid' : 'low');
        $('#result-diff').innerHTML = renderDiff(result.ops);
        $('#test-result').classList.remove('hidden'); $('#btn-check-answer').classList.add('hidden');
        const isLast = index >= items.length - 1;
        $('#btn-next-question').classList.toggle('hidden', isLast);
        $('#btn-finish-test').classList.toggle('hidden', !isLast);
        if (items.length === 1 && result.score >= 1) $('#btn-finish-test').classList.remove('hidden');
    }
    $('#btn-next-question').addEventListener('click', () => { testState.index++; showTestQuestion(); });
    $('#btn-finish-test').addEventListener('click', showTestSummary);
    $('#btn-test-again').addEventListener('click', () => { Router.stack = ['home']; Router.go('testSetup', 'Test Setup'); populateTestSetup(); });

    function showTestSummary() {
        clearInterval(timerInterval);
        const { scores, items, startTime } = testState; const avg = scores.reduce((a, b) => a + b, 0) / scores.length; const pct = Math.round(avg * 100);
        $('#test-prompt').classList.add('hidden'); $('#test-answer-input').classList.add('hidden');
        $('#btn-check-answer').classList.add('hidden'); $('#test-result').classList.add('hidden');
        $('#test-timer-display').classList.add('hidden'); $('#timer-bar').classList.add('hidden');
        $('#test-progress-fill').style.width = '100%';
        const summary = $('#test-summary'); summary.classList.remove('hidden');
        $('#summary-pct').textContent = pct + '%';
        $('#summary-label').textContent = pct === 100 ? '🎉 Perfect Score!' : pct >= 75 ? '👏 Great Job!' : pct >= 40 ? '📖 Keep Studying!' : '💪 Don\'t give up!';
        $('#summary-detail').textContent = `${scores.length} question${scores.length > 1 ? 's' : ''} · ${pct}% average`;
        const ring = $('#summary-ring'), circ = 2 * Math.PI * 54;
        ring.style.strokeDasharray = circ; ring.style.strokeDashoffset = circ;
        requestAnimationFrame(() => ring.style.strokeDashoffset = circ * (1 - avg));
        const hist = Store.history();
        hist.unshift({
            id: uid(), date: Date.now(), scope: testState.mode, avgScore: avg,
            itemCount: items.length, timeTakenMs: Date.now() - startTime,
            chapterNames: [...new Set(items.map(i => i.chName).filter(Boolean))].join(', ')
        });
        if (hist.length > 100) hist.length = 100; Store.saveHistory(hist);
        updateDueBanner();
        if (pct === 100) launchConfetti();
    }

    // ══════════════════ FLASHCARD MODE ══════════════════
    let fcState = null;
    function showFlashcard() {
        const { items, index } = testState; const item = items[index], total = items.length;
        fcState = { flipped: false, gotIt: 0, needReview: 0 };
        $('#fc-progress-text').textContent = `Card ${index + 1} / ${total}`;
        $('#fc-progress-fill').style.width = `${(index / total) * 100}%`;
        $('#fc-front-label').textContent = item.type === 'definition' ? 'Term' : 'Question';
        $('#fc-front-content').textContent = item.prompt;
        $('#fc-back-label').textContent = item.type === 'definition' ? 'Definition' : 'Answer';
        $('#fc-back-content').textContent = item.answer;
        $('#flashcard').classList.remove('flipped');
        $('#fc-summary').classList.add('hidden');
        $$('.flashcard-actions .pill-btn').forEach(b => b.style.display = '');
        $('#flashcard-scene').style.display = ''; try { $('.flashcard-progress').style.display = ''; } catch { }
    }
    $('#flashcard-scene').addEventListener('click', () => { $('#flashcard').classList.toggle('flipped'); });
    $('#btn-fc-easy').addEventListener('click', () => { if (testState.items[testState.index].itemId) updateSR(testState.items[testState.index].itemId, 5); advanceFC(); });
    $('#btn-fc-hard').addEventListener('click', () => { if (testState.items[testState.index].itemId) updateSR(testState.items[testState.index].itemId, 1); advanceFC(); });
    $('#btn-fc-prev').addEventListener('click', () => { if (testState.index > 0) { testState.index--; showFlashcard(); } });
    $('#btn-fc-next').addEventListener('click', () => advanceFC());
    function advanceFC() {
        if (testState.index >= testState.items.length - 1) { showFCSummary(); return; }
        testState.index++; showFlashcard();
    }
    function showFCSummary() {
        $('#flashcard-scene').style.display = 'none'; $$('.flashcard-actions .pill-btn').forEach(b => b.style.display = 'none');
        $('#fc-summary').classList.remove('hidden'); $('#fc-summary-detail').textContent = `You reviewed ${testState.items.length} cards.`;
        $('#fc-progress-fill').style.width = '100%'; updateDueBanner();
    }
    $('#btn-fc-done').addEventListener('click', () => { Router.stack = ['home']; Router.go('home'); renderSubjects(); });

    // ══════════════════ HISTORY ══════════════════
    $('#btn-history-nav').addEventListener('click', () => { Router.go('history', 'History'); renderHistory(); });
    function renderHistory() {
        const hist = Store.history(), list = $('#history-list'), empty = $('#empty-history'); list.innerHTML = '';
        if (!hist.length) { empty.classList.remove('hidden'); return; } empty.classList.add('hidden');
        hist.forEach(h => {
            const pct = Math.round(h.avgScore * 100); const cls = pct === 100 ? 'perfect' : pct >= 75 ? 'good' : pct >= 40 ? 'mid' : 'low';
            const d = new Date(h.date); const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            const el = document.createElement('div'); el.className = 'history-item';
            el.innerHTML = `<div class="history-date">${dateStr}</div>
      <div class="history-info"><div class="history-scope">${escHtml(h.scope)} · ${h.itemCount} items</div>
      <div class="history-chapter">${escHtml(h.chapterNames || '')}</div></div>
      <div class="history-score ${cls}">${pct}%</div>`;
            list.appendChild(el);
        });
    }
    $('#btn-clear-history').addEventListener('click', () => openConfirm('Clear all history?', () => { Store.saveHistory([]); renderHistory(); }));

    // ══════════════════ STATS DASHBOARD ══════════════════
    $('#btn-stats-nav').addEventListener('click', () => { Router.go('stats', 'Dashboard'); renderStats(); });
    function renderStats() {
        const hist = Store.history(), chs = allChapters();
        $('#stat-total-tests').textContent = hist.length;
        const avgAll = hist.length ? hist.reduce((a, h) => a + h.avgScore, 0) / hist.length : 0;
        $('#stat-avg-score').textContent = Math.round(avgAll * 100) + '%';
        let totalItems = 0; chs.forEach(ch => totalItems += ch.definitions.length + ch.qa.length);
        $('#stat-total-items').textContent = totalItems;
        const days = new Set(hist.map(h => new Date(h.date).toDateString()));
        let streak = 0, d = new Date();
        while (days.has(d.toDateString())) { streak++; d.setDate(d.getDate() - 1); }
        $('#stat-streak').textContent = streak;
        const grid = $('#streak-grid'); grid.innerHTML = '';
        const today = new Date(); today.setHours(0, 0, 0, 0);
        for (let i = 55; i >= 0; i--) {
            const day = new Date(today); day.setDate(day.getDate() - i);
            const cell = document.createElement('div'); cell.className = 'streak-cell';
            cell.title = day.toLocaleDateString();
            if (days.has(day.toDateString())) cell.classList.add('active');
            if (i === 0) cell.classList.add('today');
            grid.appendChild(cell);
        }
        const bars = $('#chapter-bars'); bars.innerHTML = '';
        chs.forEach(ch => {
            const chHist = hist.filter(h => h.chapterNames && h.chapterNames.includes(ch.name));
            const avg = chHist.length ? chHist.reduce((a, h) => a + h.avgScore, 0) / chHist.length : 0;
            const pct = Math.round(avg * 100);
            const row = document.createElement('div'); row.className = 'chapter-bar-item';
            row.innerHTML = `<div class="chapter-bar-label">${escHtml(ch.name)}</div>
      <div class="chapter-bar-track"><div class="chapter-bar-fill" style="width:${pct}%"></div></div>
      <div class="chapter-bar-value">${pct}%</div>`;
            bars.appendChild(row);
        });
        const sr = Store.srData(), weak = $('#weakest-items'), noWeak = $('#no-weak-items'); weak.innerHTML = '';
        const allItems = [];
        chs.forEach(ch => {
            ch.definitions.forEach(d => { const s = sr[d.id]; if (s && s.ef < 2.2) allItems.push({ prompt: d.term, ef: s.ef, ch: ch.name }); });
            ch.qa.forEach(q => { const s = sr[q.id]; if (s && s.ef < 2.2) allItems.push({ prompt: q.question, ef: s.ef, ch: ch.name }); });
        });
        allItems.sort((a, b) => a.ef - b.ef);
        if (!allItems.length) { noWeak.classList.remove('hidden'); }
        else {
            noWeak.classList.add('hidden'); allItems.slice(0, 8).forEach(it => {
                const el = document.createElement('div'); el.className = 'weak-item';
                el.innerHTML = `<span class="weak-prompt">${escHtml(truncate(it.prompt, 50))}</span><span class="weak-score">${it.ch}</span>`;
                weak.appendChild(el);
            });
        }
    }

    // ══════════════════ THEME TOGGLE ══════════════════
    const settings = Store.settings();
    document.documentElement.setAttribute('data-theme', settings.theme || 'dark');
    updateThemeIcons();
    $('#btn-theme-toggle').addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme');
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        settings.theme = next; Store.saveSettings(settings); updateThemeIcons();
    });
    function updateThemeIcons() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        $('#icon-moon').classList.toggle('hidden', !isDark);
        $('#icon-sun').classList.toggle('hidden', isDark);
    }

    // ══════════════════ KEYBOARD SHORTCUTS ══════════════════
    let toastTimeout;
    function showToast(msg) {
        const t = $('#shortcut-toast'); t.textContent = msg; t.classList.remove('hidden');
        clearTimeout(toastTimeout); toastTimeout = setTimeout(() => t.classList.add('hidden'), 1800);
    }
    document.addEventListener('keydown', e => {
        const tag = document.activeElement?.tagName;
        const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

        if (e.key === 'Escape') {
            if (!$('#modal-overlay').classList.contains('hidden')) { App.closeModal(); return; }
            if (!$('#confirm-overlay').classList.contains('hidden')) { $('#confirm-overlay').classList.add('hidden'); return; }
            Router.back(); return;
        }
        if (e.ctrlKey && e.key === 'f' && !inInput) { e.preventDefault(); $('#search-input').focus(); showToast('⌨ Search (Ctrl+F)'); return; }
        if (e.ctrlKey && e.key === 'e' && !inInput) { e.preventDefault(); $('#btn-export').click(); showToast('⌨ Exported!'); return; }
        if (e.ctrlKey && e.key === 'n' && !inInput) {
            e.preventDefault();
            const activeView = $$('.view.active')[0]?.id;
            if (activeView === 'view-home') $('#btn-add-subject').click();
            else if (activeView === 'view-subject') $('#btn-add-chapter').click();
            showToast('⌨ New item (Ctrl+N)'); return;
        }
        if (!inInput) {
            const testActive = views.testRunner?.classList.contains('active');
            const resultVisible = !$('#test-result').classList.contains('hidden');
            if (testActive && resultVisible && (e.key === 'ArrowRight' || e.key === 'Enter')) {
                e.preventDefault();
                if (!$('#btn-next-question').classList.contains('hidden')) $('#btn-next-question').click();
                else if (!$('#btn-finish-test').classList.contains('hidden')) $('#btn-finish-test').click();
                return;
            }
            if (views.flashcard?.classList.contains('active')) {
                if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); $('#flashcard').classList.toggle('flipped'); }
                if (e.key === 'ArrowRight') $('#btn-fc-next').click();
                if (e.key === 'ArrowLeft') $('#btn-fc-prev').click();
            }
        }
    });

    // ══════════════════ CONFETTI ══════════════════
    function launchConfetti() {
        const canvas = $('#confetti-canvas'), ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth; canvas.height = window.innerHeight;
        const particles = []; const colors = ['#8b5cf6', '#06b6d4', '#ec4899', '#34d399', '#fbbf24', '#f87171', '#60a5fa'];
        for (let i = 0; i < 120; i++) {
            particles.push({
                x: canvas.width / 2, y: canvas.height / 2,
                vx: (Math.random() - 0.5) * 16, vy: Math.random() * -14 - 4,
                size: Math.random() * 6 + 3, color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * 360, rotSpeed: (Math.random() - 0.5) * 10,
                gravity: 0.25, opacity: 1, decay: 0.008 + Math.random() * 0.008
            });
        }
        let frame = 0;
        function animate() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            let alive = false;
            particles.forEach(p => {
                p.vy += p.gravity; p.x += p.vx; p.y += p.vy; p.rotation += p.rotSpeed; p.opacity -= p.decay;
                if (p.opacity <= 0) return; alive = true;
                ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation * Math.PI / 180);
                ctx.globalAlpha = p.opacity; ctx.fillStyle = p.color;
                ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
                ctx.restore();
            });
            frame++;
            if (alive && frame < 200) requestAnimationFrame(animate);
            else ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        animate();
    }

    // ────── Init ──────
    updateDueBanner();

    return { testSingleItem, getDueItems, updateDueBanner };
})();
