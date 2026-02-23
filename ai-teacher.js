const AITeacher = (() => {
  'use strict';

  const {
    $, escHtml, Router, getStudentDataSnapshot, applyAIActions
  } = App;

  const STORAGE_KEY = 'studyai_ai_teacher_state_v1';

  const els = {
    nav: $('#btn-ai-nav'),
    view: $('#view-ai-teacher'),
    contextStats: $('#ai-context-stats'),
    apiStatus: $('#ai-api-status'),
    chatThread: $('#ai-chat-thread'),
    chatForm: $('#ai-chat-form'),
    chatInput: $('#ai-chat-input'),
    sendBtn: $('#btn-ai-send'),
    clearBtn: $('#btn-ai-clear-chat'),
    refreshBtn: $('#btn-ai-refresh-context'),
    testBtn: $('#btn-ai-generate-test'),
    autoApply: $('#ai-auto-apply'),
    testContainer: $('#ai-test-container')
  };

  if (!els.nav || !els.view) return {};

  const state = {
    messages: [],
    personalizedTest: null,
    lastSnapshot: null,
    busy: false,
    config: { configured: null, model: null, baseUrl: null, promptLineCount: null }
  };

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (Array.isArray(parsed.messages)) state.messages = parsed.messages;
      if (parsed.personalizedTest && typeof parsed.personalizedTest === 'object') state.personalizedTest = parsed.personalizedTest;
    } catch { }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      messages: state.messages,
      personalizedTest: state.personalizedTest
    }));
  }

  function addMessage(role, content) {
    state.messages.push({
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role,
      content: String(content || ''),
      ts: Date.now()
    });
    if (state.messages.length > 80) state.messages = state.messages.slice(-80);
    saveState();
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    els.sendBtn.disabled = isBusy;
    els.sendBtn.textContent = isBusy ? 'Thinking...' : 'Send';
    els.chatInput.disabled = isBusy;
    els.testBtn.disabled = isBusy;
    els.refreshBtn.disabled = isBusy;
  }

  function ensureWelcomeMessage() {
    if (state.messages.length) return;
    addMessage('assistant', [
      '**Welcome to your AI Study Teacher.**',
      '- I can teach any topic and personalize explanations using your saved data.',
      '- I can generate personalized tests from your subjects, chapters, and weak areas.',
      '- I follow Custom Math Text format, for example `[[m: x^2 + y^2 = r^2 ]]`.'
    ].join('\n'));
  }

  function buildSnapshot() {
    state.lastSnapshot = getStudentDataSnapshot();
    const t = state.lastSnapshot.totals || {};
    els.contextStats.textContent = `Context: ${t.subjects || 0} subjects, ${t.chapters || 0} chapters, ${t.definitions || 0} definitions, ${t.qa || 0} Q&A`;
    return state.lastSnapshot;
  }

  function setApiStatus(message, level = 'info') {
    els.apiStatus.classList.remove('hidden', 'warn', 'ok');
    if (level === 'warn') els.apiStatus.classList.add('warn');
    if (level === 'ok') els.apiStatus.classList.add('ok');
    els.apiStatus.textContent = message;
  }

  async function fetchConfig() {
    try {
      const res = await fetch('/api/ai-teacher/config');
      if (!res.ok) throw new Error('Could not load AI config.');
      const data = await res.json();
      state.config = data;
      if (data.configured) {
        setApiStatus(`AI configured (${data.model}) • Prompt lines: ${data.promptLineCount}`, 'ok');
      } else {
        setApiStatus('AI is not configured. Update OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_MODEL, OPENAI_COMPAT_API_KEY in .env', 'warn');
      }
    } catch {
      setApiStatus('AI backend unavailable. Run app with `npm start` to enable AI Teacher.', 'warn');
    }
  }

  function formatInline(raw) {
    let safe = escHtml(raw);
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/`([^`]+?)`/g, '<code>$1</code>');
    safe = safe.replace(/\[\[m:\s*(.+?)\s*\]\]/g, '<span class="ai-math-inline">$1</span>');
    return safe;
  }

  function renderAssistantMarkdown(rawText) {
    const mathBlocks = [];
    let text = String(rawText || '');
    text = text.replace(/\[\[math\]\]([\s\S]*?)\[\[\/math\]\]/gi, (_m, expr) => {
      const token = `__MATH_BLOCK_${mathBlocks.length}__`;
      mathBlocks.push(`<pre class="ai-math-block">${escHtml(String(expr || '').trim())}</pre>`);
      return token;
    });

    const lines = text.split(/\r?\n/);
    let html = '';
    let listMode = '';

    const closeList = () => {
      if (!listMode) return;
      html += listMode === 'ul' ? '</ul>' : '</ol>';
      listMode = '';
    };

    lines.forEach(line => {
      const trimmed = line.trim();
      const bullet = /^\-\s+(.+)$/.exec(trimmed);
      const numbered = /^(\d+)\.\s+(.+)$/.exec(trimmed);

      if (!trimmed) {
        closeList();
        html += '<div class="ai-spacer"></div>';
        return;
      }

      if (bullet) {
        if (listMode !== 'ul') { closeList(); html += '<ul>'; listMode = 'ul'; }
        html += `<li>${formatInline(bullet[1])}</li>`;
        return;
      }

      if (numbered) {
        if (listMode !== 'ol') { closeList(); html += '<ol>'; listMode = 'ol'; }
        html += `<li>${formatInline(numbered[2])}</li>`;
        return;
      }

      closeList();
      html += `<p>${formatInline(line)}</p>`;
    });
    closeList();

    mathBlocks.forEach((block, i) => {
      html = html.split(`__MATH_BLOCK_${i}__`).join(block);
    });
    return html;
  }

  function renderMessage(msg) {
    const item = document.createElement('div');
    item.className = `ai-msg ${msg.role}`;
    const who = msg.role === 'assistant' ? 'AI Teacher' : msg.role === 'user' ? 'You' : 'System';
    const time = new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    item.innerHTML = `
      <div class="ai-msg-head"><strong>${who}</strong><span>${time}</span></div>
      <div class="ai-msg-body"></div>
    `;
    const body = item.querySelector('.ai-msg-body');
    if (msg.role === 'assistant') body.innerHTML = renderAssistantMarkdown(msg.content);
    else body.innerHTML = `<p>${formatInline(msg.content).replace(/\n/g, '<br />')}</p>`;
    return item;
  }

  function renderChat() {
    els.chatThread.innerHTML = '';
    state.messages.forEach(msg => els.chatThread.appendChild(renderMessage(msg)));
    els.chatThread.scrollTop = els.chatThread.scrollHeight;
  }

  function questionTypeLabel(type) {
    const map = {
      short_answer: 'Short Answer',
      long_answer: 'Long Answer',
      mcq: 'MCQ',
      true_false: 'True/False',
      fill_blank: 'Fill in the Blank'
    };
    return map[type] || (type ? String(type) : 'Question');
  }

  function renderPersonalizedTest() {
    if (!state.personalizedTest || !Array.isArray(state.personalizedTest.questions)) {
      els.testContainer.innerHTML = '<p class="empty-state small">No AI-generated test yet.</p>';
      return;
    }
    const test = state.personalizedTest;
    const title = escHtml(test.title || 'Personalized Test');
    const instructions = escHtml(test.instructions || 'Answer each question before checking the solution.');
    let html = `<div class="ai-test-head"><strong>${title}</strong><p>${instructions}</p></div>`;
    test.questions.forEach((q, i) => {
      const prompt = escHtml(q.prompt || '');
      const answer = escHtml(q.answer || '');
      const label = escHtml(questionTypeLabel(q.type));
      const hint = q.hint ? `<p class="ai-test-hint"><strong>Hint:</strong> ${escHtml(q.hint)}</p>` : '';
      let options = '';
      if (Array.isArray(q.options) && q.options.length) {
        options = '<ul class="ai-test-options">' + q.options.map(o => `<li>${escHtml(String(o))}</li>`).join('') + '</ul>';
      }
      html += `
        <article class="ai-test-question">
          <div class="ai-test-meta"><strong>Q${i + 1}</strong><span>${label}</span></div>
          <p class="ai-test-prompt">${prompt}</p>
          ${options}
          ${hint}
          <button class="pill-btn secondary small" data-answer-toggle="ans-${i}">Show Answer</button>
          <div id="ans-${i}" class="ai-test-answer hidden">
            <p><strong>Answer:</strong> ${answer}</p>
            ${q.explanation ? `<p><strong>Why:</strong> ${escHtml(String(q.explanation))}</p>` : ''}
          </div>
        </article>
      `;
    });
    els.testContainer.innerHTML = html;
  }

  function summarizeActionResult(result) {
    if (!result) return;
    if (!result.changed) {
      addMessage('system', 'AI proposed data actions, but no changes were applied.');
      return;
    }
    addMessage('system', `Applied AI data actions: ${result.applied} success, ${result.failed} failed.`);
  }

  async function callTeacher(mode = 'chat', userPrompt = '', testRequest = null) {
    if (!userPrompt.trim()) return;

    addMessage('user', userPrompt.trim());
    renderChat();
    setBusy(true);

    const snapshot = buildSnapshot();
    const modelMessages = state.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch('/api/ai-teacher/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          testRequest,
          messages: modelMessages,
          studentSnapshot: snapshot
        })
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || payload.details || 'AI request failed');

      if (payload.reply && String(payload.reply).trim()) addMessage('assistant', String(payload.reply).trim());
      else addMessage('assistant', 'No teaching text returned. Please try again.');

      if (Array.isArray(payload.actions) && payload.actions.length) {
        if (els.autoApply.checked) {
          const result = applyAIActions(payload.actions);
          summarizeActionResult(result);
          buildSnapshot();
        } else {
          addMessage('system', `AI generated ${payload.actions.length} data action(s). Enable "Allow AI data control" to auto-apply.`);
        }
      }

      if (payload.personalizedTest && typeof payload.personalizedTest === 'object') {
        state.personalizedTest = payload.personalizedTest;
        saveState();
      }
    } catch (error) {
      addMessage('system', `AI request error: ${error.message}`);
    } finally {
      setBusy(false);
      renderChat();
      renderPersonalizedTest();
    }
  }

  function clearChat() {
    state.messages = [];
    state.personalizedTest = null;
    saveState();
    ensureWelcomeMessage();
    renderChat();
    renderPersonalizedTest();
  }

  function openTeacherView() {
    Router.go('aiTeacher', 'AI Teacher');
    buildSnapshot();
    renderChat();
    renderPersonalizedTest();
  }

  function wireEvents() {
    els.nav.addEventListener('click', openTeacherView);
    els.refreshBtn.addEventListener('click', () => buildSnapshot());
    els.clearBtn.addEventListener('click', clearChat);
    els.chatForm.addEventListener('submit', e => {
      e.preventDefault();
      const text = els.chatInput.value.trim();
      if (!text || state.busy) return;
      els.chatInput.value = '';
      callTeacher('chat', text);
    });
    els.testBtn.addEventListener('click', () => {
      if (state.busy) return;
      const prompt = [
        'Generate a personalized test using my stored data.',
        'Focus on weak areas and recently studied chapters.',
        'Return teaching tips plus a machine-readable personalized test.'
      ].join(' ');
      callTeacher('generate_test', prompt, { focus: 'weak_areas', defaultQuestionCount: 7 });
    });
    els.testContainer.addEventListener('click', e => {
      const target = e.target.closest('[data-answer-toggle]');
      if (!target) return;
      const id = target.getAttribute('data-answer-toggle');
      const ans = document.getElementById(id);
      if (!ans) return;
      ans.classList.toggle('hidden');
      target.textContent = ans.classList.contains('hidden') ? 'Show Answer' : 'Hide Answer';
    });
  }

  loadState();
  ensureWelcomeMessage();
  wireEvents();
  buildSnapshot();
  fetchConfig();
  renderChat();
  renderPersonalizedTest();

  return { openTeacherView };
})();
