/* ═══════════════════════════════════════════════════════
   Study AI — Core (Storage, Router, Subjects, Chapters)
   ═══════════════════════════════════════════════════════ */
const App = (() => {
  'use strict';
  const $ = (s, p = document) => p.querySelector(s);
  const $$ = (s, p = document) => [...p.querySelectorAll(s)];
  const uid = () => crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  const escHtml = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
  const truncate = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;

  // ────── Storage (versioned + auto-backup) ──────
  const DATA_VERSION = 2;
  const Store = {
    _get(k, d) {
      try {
        const raw = localStorage.getItem(k);
        if (raw === null) return d;
        const parsed = JSON.parse(raw);
        return parsed ?? d;
      } catch {
        try {
          const backup = localStorage.getItem(k + '_backup');
          if (backup) {
            const restored = JSON.parse(backup);
            localStorage.setItem(k, backup);
            console.warn(`[StudyAI] Restored ${k} from backup`);
            return restored ?? d;
          }
        } catch { }
        return d;
      }
    },
    _set(k, v) {
      const json = JSON.stringify(v);
      const current = localStorage.getItem(k);
      if (current !== null) localStorage.setItem(k + '_backup', current);
      localStorage.setItem(k, json);
    },
    subjects() { return this._get('studyai_subjects', []) },
    saveSubjects(s) { this._set('studyai_subjects', s) },
    history() { return this._get('studyai_history', []) },
    saveHistory(h) { this._set('studyai_history', h) },
    settings() { return this._get('studyai_settings', { theme: 'dark' }) },
    saveSettings(s) { this._set('studyai_settings', s) },
    srData() { return this._get('studyai_sr', {}) },
    saveSR(d) { this._set('studyai_sr', d) }
  };

  // ────── Data Migration ──────
  function migrateData() {
    const storedVer = parseInt(localStorage.getItem('studyai_version') || '0');

    // v1 → v2: flat chapters array → subjects with chapters
    if (storedVer < 2) {
      const oldChapters = (() => {
        try { return JSON.parse(localStorage.getItem('studyai_chapters')) || [] } catch { return [] }
      })();
      if (oldChapters.length > 0) {
        // Ensure old fields
        oldChapters.forEach(ch => {
          if (ch.notes === undefined) ch.notes = '';
          ch.definitions.forEach(d => { if (!d.tags) d.tags = []; });
          ch.qa.forEach(q => { if (!q.tags) q.tags = []; });
        });
        const generalSubject = { id: uid(), name: 'General', color: '#8b5cf6', chapters: oldChapters };
        Store.saveSubjects([generalSubject]);
        // Keep old key as backup
        localStorage.setItem('studyai_chapters_v1_backup', localStorage.getItem('studyai_chapters'));
      }
    }

    // Ensure all subjects/chapters have required fields
    const subjects = Store.subjects();
    let changed = false;
    subjects.forEach(sub => {
      if (!sub.color) { sub.color = '#8b5cf6'; changed = true; }
      if (!sub.chapters) { sub.chapters = []; changed = true; }
      sub.chapters.forEach(ch => {
        if (ch.notes === undefined) { ch.notes = ''; changed = true; }
        ch.definitions.forEach(d => { if (!d.tags) { d.tags = []; changed = true; } });
        ch.qa.forEach(q => { if (!q.tags) { q.tags = []; changed = true; } });
      });
    });
    if (changed) Store.saveSubjects(subjects);
    localStorage.setItem('studyai_version', String(DATA_VERSION));
    return subjects;
  }

  let subjects = migrateData();
  let currentSubjectId = null;
  let currentChapterId = null;

  function persist() { Store.saveSubjects(subjects); }

  // Helper: flat list of all chapters (with subjectId/subjectName attached)
  function allChapters() {
    const flat = [];
    subjects.forEach(sub => {
      sub.chapters.forEach(ch => {
        flat.push(Object.assign({}, ch, { subjectId: sub.id, subjectName: sub.name }));
      });
    });
    return flat;
  }

  // Helper: get current subject
  function currentSubject() { return subjects.find(s => s.id === currentSubjectId) || null; }

  // Helper: get current chapter
  function currentChapter() {
    const sub = currentSubject();
    if (!sub) return null;
    return sub.chapters.find(c => c.id === currentChapterId) || null;
  }

  // ────── Icons ──────
  const ICON = {
    edit: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
    test: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'
  };

  // ────── Router ──────
  const views = {};
  ['home', 'subject', 'chapter', 'testSetup', 'testRunner', 'flashcard', 'history', 'stats'].forEach(n => {
    const id = 'view-' + n.replace(/([A-Z])/g, '-$1').toLowerCase();
    views[n] = ($('#' + id)) || $(`#view-${n}`);
  });
  // manual overrides for ids that don't match convention
  views.testSetup = $('#view-test-setup'); views.testRunner = $('#view-test-runner');
  views.flashcard = $('#view-flashcard');
  views.history = $('#view-history'); views.stats = $('#view-stats');

  const btnBack = $('#btn-back'), topTitle = $('#topbar-title');
  const Router = {
    stack: ['home'],
    go(name, title) {
      Object.values(views).forEach(v => v && v.classList.remove('active'));
      if (views[name]) views[name].classList.add('active');
      this.stack.push(name);
      btnBack.classList.toggle('hidden', this.stack.length <= 1);
      topTitle.textContent = title || 'Study AI';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    back() {
      if (this.stack.length <= 1) return;
      this.stack.pop();
      const prev = this.stack[this.stack.length - 1];
      Object.values(views).forEach(v => v && v.classList.remove('active'));
      if (views[prev]) views[prev].classList.add('active');
      btnBack.classList.toggle('hidden', this.stack.length <= 1);
      if (prev === 'home') { topTitle.textContent = 'Study AI'; renderSubjects(); }
      else if (prev === 'subject') { const sub = currentSubject(); topTitle.textContent = sub ? sub.name : 'Subject'; renderSubjectDetail(); }
      else if (prev === 'chapter') { renderChapterDetail(); }
    }
  };
  btnBack.addEventListener('click', () => Router.back());

  // ────── Modal ──────
  function openModal(title, fields, onSave) {
    $('#modal-title').textContent = title;
    const container = $('#modal-fields'); container.innerHTML = '';
    fields.forEach(f => {
      if (f.type === 'tags') {
        const div = document.createElement('div'); div.className = 'tag-select';
        const lbl = document.createElement('label'); lbl.className = 'field-label'; lbl.textContent = f.label || 'Tags';
        container.appendChild(lbl);
        ['easy', 'hard', 'review'].forEach(t => {
          const btn = document.createElement('button'); btn.type = 'button';
          btn.className = 'tag-chip ' + t + (f.value?.includes(t) ? ' selected' : '');
          btn.textContent = { easy: '🟢 Easy', hard: '🔴 Hard', review: '🟡 Review' }[t];
          btn.addEventListener('click', () => btn.classList.toggle('selected'));
          div.appendChild(btn);
        });
        div.dataset.name = f.name; container.appendChild(div);
        return;
      }
      if (f.type === 'color') {
        const lbl = document.createElement('label'); lbl.className = 'field-label'; lbl.textContent = f.label;
        container.appendChild(lbl);
        const inp = document.createElement('input'); inp.type = 'color'; inp.name = f.name;
        inp.value = f.value || '#8b5cf6'; inp.className = 'input-field color-input';
        container.appendChild(inp);
        return;
      }
      const lbl = document.createElement('label'); lbl.className = 'field-label'; lbl.textContent = f.label;
      container.appendChild(lbl);
      let inp;
      if (f.type === 'textarea') { inp = document.createElement('textarea'); inp.rows = 4; inp.className = 'input-field textarea'; }
      else { inp = document.createElement('input'); inp.type = f.type || 'text'; inp.className = 'input-field'; }
      inp.name = f.name; inp.placeholder = f.placeholder || ''; inp.value = f.value || ''; inp.required = f.required !== false;
      container.appendChild(inp);
    });
    $('#modal-overlay').classList.remove('hidden');
    container.querySelector('input,textarea')?.focus();
    $('#modal-form').onsubmit = e => {
      e.preventDefault();
      const data = {};
      container.querySelectorAll('input,textarea').forEach(i => data[i.name] = i.value.trim());
      container.querySelectorAll('.tag-select').forEach(div => {
        data[div.dataset.name] = $$('.tag-chip.selected', div).map(b => b.classList[1]);
      });
      onSave(data); closeModal();
    };
  }
  function closeModal() { $('#modal-overlay').classList.add('hidden'); }
  function openConfirm(msg, onYes) {
    $('#confirm-message').textContent = msg; $('#confirm-overlay').classList.remove('hidden');
    $('#btn-confirm-yes').onclick = () => { $('#confirm-overlay').classList.add('hidden'); onYes(); };
    $('#btn-confirm-no').onclick = () => { $('#confirm-overlay').classList.add('hidden'); };
  }
  $('#modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  $('#confirm-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) $('#confirm-overlay').classList.add('hidden'); });
  $('#btn-modal-cancel').addEventListener('click', closeModal);

  // ══════════════════ SUBJECTS ══════════════════
  const SUBJECT_COLORS = ['#8b5cf6', '#06b6d4', '#ec4899', '#f59e0b', '#10b981', '#f87171', '#3b82f6', '#a855f7'];

  function renderSubjects() {
    const grid = $('#subject-grid'), empty = $('#empty-home');
    grid.innerHTML = '';
    if (!subjects.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    subjects.forEach((sub, idx) => {
      const card = document.createElement('div'); card.className = 'subject-card';
      card.draggable = true; card.dataset.idx = idx;
      const chCount = sub.chapters.length;
      let itemCount = 0;
      sub.chapters.forEach(ch => itemCount += ch.definitions.length + ch.qa.length);
      card.innerHTML = `
        <div class="subject-color-bar" style="background:${sub.color}"></div>
        <div class="subject-card-body">
          <div class="subject-name">${escHtml(sub.name)}</div>
          <div class="subject-meta">${chCount} chapter${chCount !== 1 ? 's' : ''} · ${itemCount} item${itemCount !== 1 ? 's' : ''}</div>
          <div class="card-actions">
            <button class="icon-btn btn-edit-sub" title="Edit">${ICON.edit}</button>
            <button class="icon-btn btn-del-sub" title="Delete">${ICON.trash}</button>
          </div>
        </div>`;
      card.querySelector('.btn-edit-sub').addEventListener('click', e => { e.stopPropagation(); editSubject(sub.id); });
      card.querySelector('.btn-del-sub').addEventListener('click', e => { e.stopPropagation(); deleteSubject(sub.id); });
      card.addEventListener('click', () => openSubject(sub.id));
      // Drag
      card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', idx); card.classList.add('dragging'); });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', e => {
        e.preventDefault(); card.classList.remove('drag-over');
        const from = parseInt(e.dataTransfer.getData('text/plain'));
        const to = idx; if (from === to) return;
        const [moved] = subjects.splice(from, 1); subjects.splice(to, 0, moved);
        persist(); renderSubjects();
      });
      grid.appendChild(card);
    });
  }

  $('#btn-add-subject').addEventListener('click', () => {
    const nextColor = SUBJECT_COLORS[subjects.length % SUBJECT_COLORS.length];
    openModal('Add Subject', [
      { name: 'name', label: 'Subject Name', placeholder: 'e.g. Biology, History, Math' },
      { name: 'color', label: 'Color', type: 'color', value: nextColor }
    ], data => {
      subjects.push({ id: uid(), name: data.name, color: data.color || nextColor, chapters: [] });
      persist(); renderSubjects();
    });
  });

  function editSubject(id) {
    const sub = subjects.find(s => s.id === id); if (!sub) return;
    openModal('Edit Subject', [
      { name: 'name', label: 'Subject Name', value: sub.name },
      { name: 'color', label: 'Color', type: 'color', value: sub.color }
    ], data => { sub.name = data.name; sub.color = data.color; persist(); renderSubjects(); });
  }

  function deleteSubject(id) {
    openConfirm('Delete this subject and ALL its chapters?', () => {
      subjects = subjects.filter(s => s.id !== id); persist(); renderSubjects();
    });
  }

  function openSubject(id) {
    currentSubjectId = id;
    const sub = currentSubject();
    if (!sub) return;
    Router.go('subject', sub.name);
    renderSubjectDetail();
  }

  // ══════════════════ SUBJECT DETAIL (Chapters) ══════════════════
  function renderSubjectDetail() {
    const sub = currentSubject(); if (!sub) return;
    $('#subject-detail-title').textContent = sub.name + ' — Chapters';
    const grid = $('#chapter-grid'), empty = $('#empty-subject');
    grid.innerHTML = '';
    if (!sub.chapters.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    sub.chapters.forEach((ch, idx) => {
      const card = document.createElement('div'); card.className = 'chapter-card';
      card.draggable = true; card.dataset.idx = idx;
      const defCount = ch.definitions.length, qaCount = ch.qa.length;
      card.innerHTML = `
        <div class="chapter-number">Ch ${escHtml(String(ch.number))}</div>
        <div class="chapter-name">${escHtml(ch.name)}</div>
        <div class="chapter-meta">${defCount} def · ${qaCount} Q&A</div>
        <div class="card-actions">
          <button class="icon-btn btn-edit-ch" title="Edit">${ICON.edit}</button>
          <button class="icon-btn btn-del-ch" title="Delete">${ICON.trash}</button>
        </div>`;
      card.querySelector('.btn-edit-ch').addEventListener('click', e => { e.stopPropagation(); editChapter(ch.id); });
      card.querySelector('.btn-del-ch').addEventListener('click', e => { e.stopPropagation(); deleteChapter(ch.id); });
      card.addEventListener('click', () => openChapter(ch.id));
      // Drag
      card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', idx); card.classList.add('dragging'); });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', e => {
        e.preventDefault(); card.classList.remove('drag-over');
        const from = parseInt(e.dataTransfer.getData('text/plain'));
        const to = idx; if (from === to) return;
        const [moved] = sub.chapters.splice(from, 1); sub.chapters.splice(to, 0, moved);
        persist(); renderSubjectDetail();
      });
      grid.appendChild(card);
    });
  }

  $('#btn-add-chapter').addEventListener('click', () => {
    const sub = currentSubject(); if (!sub) return;
    openModal('Add Chapter', [
      { name: 'name', label: 'Chapter Name', placeholder: 'e.g. Photosynthesis' },
      { name: 'number', label: 'Chapter Number', placeholder: 'e.g. 1', type: 'number' }
    ], data => {
      sub.chapters.push({ id: uid(), name: data.name, number: data.number, definitions: [], qa: [], notes: '' });
      persist(); renderSubjectDetail();
    });
  });

  function editChapter(id) {
    const sub = currentSubject(); if (!sub) return;
    const ch = sub.chapters.find(c => c.id === id); if (!ch) return;
    openModal('Edit Chapter', [
      { name: 'name', label: 'Chapter Name', value: ch.name },
      { name: 'number', label: 'Chapter Number', value: ch.number, type: 'number' }
    ], data => { ch.name = data.name; ch.number = data.number; persist(); renderSubjectDetail(); });
  }

  function deleteChapter(id) {
    const sub = currentSubject(); if (!sub) return;
    openConfirm('Delete this chapter and all its content?', () => {
      sub.chapters = sub.chapters.filter(c => c.id !== id); persist(); renderSubjectDetail();
    });
  }

  // ══════════════════ CHAPTER DETAIL ══════════════════
  function openChapter(id) {
    currentChapterId = id;
    const ch = currentChapter();
    if (!ch) return;
    Router.go('chapter', `Ch ${ch.number} — ${ch.name}`);
    renderChapterDetail();
  }

  function renderChapterDetail() {
    const ch = currentChapter(); if (!ch) return;
    // Tabs
    $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`#tab-${btn.dataset.tab}`).classList.add('active');
    }));

    renderItems('def', ch.definitions, 'definition');
    renderItems('qa', ch.qa, 'qa');
    // Notes
    const notesArea = $('#notes-textarea');
    notesArea.value = ch.notes || '';
    let notesTimeout;
    notesArea.oninput = () => {
      clearTimeout(notesTimeout);
      notesTimeout = setTimeout(() => {
        ch.notes = notesArea.value; persist();
        const ind = $('#notes-saved-indicator'); ind.classList.remove('hidden');
        setTimeout(() => ind.classList.add('hidden'), 1500);
      }, 600);
    };
  }

  const activeTagFilter = { def: 'all', qa: 'all' };
  $('#filter-def-tag').addEventListener('change', () => { activeTagFilter.def = $('#filter-def-tag').value; renderChapterDetail(); });
  $('#filter-qa-tag').addEventListener('change', () => { activeTagFilter.qa = $('#filter-qa-tag').value; renderChapterDetail(); });

  function renderItems(prefix, items, type) {
    const list = $(`#${prefix}-list`), empty = $(`#empty-${prefix}`);
    list.innerHTML = '';
    const filter = activeTagFilter[prefix];
    const filtered = filter === 'all' ? items : items.filter(it => it.tags?.includes(filter));
    if (!filtered.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    filtered.forEach((item, idx) => {
      const isD = type === 'definition';
      const card = makeItemCard(type, isD ? 'Definition' : 'Q&A', isD ? item.term : item.question, isD ? item.definition : item.answer, item.id, item.tags, idx);
      list.appendChild(card);
    });
  }

  function makeItemCard(type, labelText, title, body, id, tags, idx) {
    const card = document.createElement('div'); card.className = 'item-card'; card.draggable = true; card.dataset.idx = idx; card.dataset.type = type;
    let tagHtml = '';
    if (tags?.length) tags.forEach(t => tagHtml += `<span class="tag-chip ${t}">${{ easy: 'Easy', hard: 'Hard', review: 'Review' }[t]}</span>`);
    card.innerHTML = `
      <div class="item-label">${escHtml(labelText)}${tagHtml}</div>
      <div class="item-term">${escHtml(title)}</div>
      <div class="item-body">${escHtml(body)}</div>
      <div class="card-actions">
        <button class="icon-btn btn-test-item" title="Test">${ICON.test}</button>
        <button class="icon-btn btn-edit-item" title="Edit">${ICON.edit}</button>
        <button class="icon-btn btn-del-item" title="Delete">${ICON.trash}</button>
      </div>`;
    card.querySelector('.btn-edit-item').addEventListener('click', () => editItem(type, id));
    card.querySelector('.btn-del-item').addEventListener('click', () => deleteItem(type, id));
    card.querySelector('.btn-test-item').addEventListener('click', () => {
      if (typeof Features !== 'undefined' && Features.testSingleItem) Features.testSingleItem(type, id);
    });
    // Drag
    card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', idx); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', e => {
      e.preventDefault(); card.classList.remove('drag-over');
      const ch = currentChapter(); if (!ch) return;
      const arr = type === 'definition' ? ch.definitions : ch.qa;
      const from = parseInt(e.dataTransfer.getData('text/plain'));
      const to = parseInt(card.dataset.idx); if (from === to) return;
      const [moved] = arr.splice(from, 1); arr.splice(to, 0, moved);
      persist(); renderChapterDetail();
    });
    return card;
  }

  // Add / Edit / Delete items
  $('#btn-add-def').addEventListener('click', () => {
    openModal('Add Definition', [
      { name: 'term', label: 'Term', placeholder: 'e.g. Photosynthesis' },
      { name: 'definition', label: 'Definition', type: 'textarea', placeholder: 'Define the term…' },
      { name: 'tags', label: 'Tags', type: 'tags', value: [] }
    ], data => {
      const ch = currentChapter(); if (!ch) return;
      ch.definitions.push({ id: uid(), term: data.term, definition: data.definition, tags: data.tags || [] });
      persist(); renderChapterDetail();
    });
  });
  $('#btn-add-qa').addEventListener('click', () => {
    openModal('Add Q&A', [
      { name: 'question', label: 'Question', placeholder: 'Ask a question…' },
      { name: 'answer', label: 'Answer', type: 'textarea', placeholder: 'The answer…' },
      { name: 'tags', label: 'Tags', type: 'tags', value: [] }
    ], data => {
      const ch = currentChapter(); if (!ch) return;
      ch.qa.push({ id: uid(), question: data.question, answer: data.answer, tags: data.tags || [] });
      persist(); renderChapterDetail();
    });
  });

  function editItem(type, id) {
    const ch = currentChapter(); if (!ch) return;
    if (type === 'definition') {
      const d = ch.definitions.find(x => x.id === id); if (!d) return;
      openModal('Edit Definition', [
        { name: 'term', label: 'Term', value: d.term },
        { name: 'definition', label: 'Definition', type: 'textarea', value: d.definition },
        { name: 'tags', label: 'Tags', type: 'tags', value: d.tags }
      ], data => { d.term = data.term; d.definition = data.definition; d.tags = data.tags || []; persist(); renderChapterDetail(); });
    } else {
      const q = ch.qa.find(x => x.id === id); if (!q) return;
      openModal('Edit Q&A', [
        { name: 'question', label: 'Question', value: q.question },
        { name: 'answer', label: 'Answer', type: 'textarea', value: q.answer },
        { name: 'tags', label: 'Tags', type: 'tags', value: q.tags }
      ], data => { q.question = data.question; q.answer = data.answer; q.tags = data.tags || []; persist(); renderChapterDetail(); });
    }
  }

  function deleteItem(type, id) {
    openConfirm('Delete this item?', () => {
      const ch = currentChapter(); if (!ch) return;
      if (type === 'definition') ch.definitions = ch.definitions.filter(d => d.id !== id);
      else ch.qa = ch.qa.filter(q => q.id !== id);
      persist(); renderChapterDetail();
    });
  }

  // ────── Print ──────
  $('#btn-print-chapter').addEventListener('click', () => window.print());

  // ────── Search ──────
  const searchInput = $('#search-input'), searchResults = $('#search-results');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { searchResults.classList.add('hidden'); return; }
    const results = [];
    subjects.forEach(sub => {
      if (sub.name.toLowerCase().includes(q)) results.push({ type: 'subject', subId: sub.id, text: sub.name, detail: `${sub.chapters.length} chapters` });
      sub.chapters.forEach(ch => {
        if (ch.name.toLowerCase().includes(q)) results.push({ type: 'chapter', subId: sub.id, chId: ch.id, text: ch.name, detail: `in ${sub.name}` });
        ch.definitions.forEach(d => {
          if (d.term.toLowerCase().includes(q) || d.definition.toLowerCase().includes(q))
            results.push({ type: 'def', subId: sub.id, chId: ch.id, text: d.term, detail: `${sub.name} → ${ch.name}` });
        });
        ch.qa.forEach(qa => {
          if (qa.question.toLowerCase().includes(q) || qa.answer.toLowerCase().includes(q))
            results.push({ type: 'qa', subId: sub.id, chId: ch.id, text: truncate(qa.question, 60), detail: `${sub.name} → ${ch.name}` });
        });
      });
    });
    if (!results.length) { searchResults.innerHTML = '<div class="search-item">No results</div>'; searchResults.classList.remove('hidden'); return; }
    searchResults.innerHTML = '';
    results.slice(0, 12).forEach(r => {
      const div = document.createElement('div'); div.className = 'search-item';
      div.innerHTML = `<span class="search-text">${escHtml(r.text)}</span><span class="search-detail">${escHtml(r.detail)}</span>`;
      div.addEventListener('click', () => {
        searchInput.value = ''; searchResults.classList.add('hidden');
        if (r.type === 'subject') { openSubject(r.subId); }
        else { currentSubjectId = r.subId; openChapter(r.chId); }
      });
      searchResults.appendChild(div);
    });
    searchResults.classList.remove('hidden');
  });
  searchInput.addEventListener('blur', () => setTimeout(() => searchResults.classList.add('hidden'), 200));
  searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) searchInput.dispatchEvent(new Event('input')); });

  // ────── Import / Export ──────
  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(subjects, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'study-ai-export.json'; a.click(); URL.revokeObjectURL(a.href);
  });
  $('#btn-import').addEventListener('click', () => $('#import-file-input').click());
  $('#import-file-input').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!Array.isArray(imported)) { alert('Invalid file format.'); return; }
        // Detect old format (flat chapters) vs new format (subjects)
        const isOldFormat = imported.length > 0 && imported[0].definitions !== undefined && imported[0].chapters === undefined;
        openConfirm('Import data? This will REPLACE all existing data.', () => {
          if (isOldFormat) {
            // Old flat chapters → wrap in General subject
            subjects = [{ id: uid(), name: 'General', color: '#8b5cf6', chapters: imported }];
          } else {
            subjects = imported;
          }
          persist(); renderSubjects();
        });
      } catch { alert('Error reading file.'); }
    };
    reader.readAsText(file); e.target.value = '';
  });

  // ────── Init ──────
  renderSubjects();

  // Logo gradient
  const svgEl = $('header svg');
  if (svgEl) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#06b6d4"/></linearGradient>';
    svgEl.prepend(defs);
  }

  return {
    $, $$, uid, escHtml, truncate, Store, persist, Router, openModal, closeModal, openConfirm,
    subjects: () => subjects, allChapters,
    currentSubjectId: () => currentSubjectId, currentChapterId: () => currentChapterId,
    currentSubject, currentChapter,
    openSubject, openChapter, renderSubjects, renderSubjectDetail, renderChapterDetail, ICON, views
  };
})();
