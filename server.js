const express = require('express');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { fetch } = require('undici');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OPENAI_COMPAT_BASE_URL = (process.env.OPENAI_COMPAT_BASE_URL || '').replace(/\/+$/, '');
const OPENAI_COMPAT_MODEL = process.env.OPENAI_COMPAT_MODEL || 'gpt-4.1-mini';
const OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY || '';
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'prompts', 'study_teacher_system_prompt.txt');

function readSystemPrompt() {
  try {
    return fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  } catch (error) {
    console.warn('[AI Teacher] Could not read system prompt file:', error.message);
    return 'You are Study Assistant AI Teacher. Teach clearly and personalize learning from student data.';
  }
}

const STUDY_TEACHER_SYSTEM_PROMPT = readSystemPrompt();

function parseJsonCodeBlock(content, blockName) {
  const escapedName = String(blockName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('```' + escapedName + '\\s*([\\s\\S]*?)```', 'i');
  const match = content.match(regex);
  if (!match) return { cleanedContent: content, parsed: null };

  let parsed = null;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    parsed = null;
  }

  return {
    cleanedContent: content.replace(match[0], '').trim(),
    parsed
  };
}

function compactModelMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-18)
    .map(m => ({ role: m.role, content: m.content.trim() }));
}

app.use(express.json({ limit: '3mb' }));
app.use(express.static(__dirname));

app.get('/api/ai-teacher/config', (_req, res) => {
  res.json({
    configured: Boolean(OPENAI_COMPAT_BASE_URL && OPENAI_COMPAT_MODEL && OPENAI_COMPAT_API_KEY),
    baseUrl: OPENAI_COMPAT_BASE_URL || null,
    model: OPENAI_COMPAT_MODEL || null,
    promptLineCount: STUDY_TEACHER_SYSTEM_PROMPT.split(/\r?\n/).length
  });
});

app.post('/api/ai-teacher/chat', async (req, res) => {
  try {
    if (!OPENAI_COMPAT_BASE_URL || !OPENAI_COMPAT_MODEL || !OPENAI_COMPAT_API_KEY) {
      return res.status(500).json({
        error: 'AI provider is not configured. Set OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_MODEL, and OPENAI_COMPAT_API_KEY in .env.'
      });
    }

    const incomingMessages = compactModelMessages(req.body?.messages);
    if (!incomingMessages.length) return res.status(400).json({ error: 'messages is required.' });

    const studentSnapshot = req.body?.studentSnapshot || {};
    const requestMode = req.body?.mode || 'chat';
    const testRequest = req.body?.testRequest || null;

    const runtimeContext = {
      timestampIso: new Date().toISOString(),
      mode: requestMode,
      testRequest,
      studentSnapshot
    };

    const messages = [
      { role: 'system', content: STUDY_TEACHER_SYSTEM_PROMPT },
      {
        role: 'system',
        content: [
          'Runtime student context follows. Use this data for personalization and data-control actions.',
          'RUNTIME_CONTEXT_JSON_START',
          JSON.stringify(runtimeContext, null, 2),
          'RUNTIME_CONTEXT_JSON_END'
        ].join('\n')
      },
      ...incomingMessages
    ];

    const providerResponse = await fetch(`${OPENAI_COMPAT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_COMPAT_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_COMPAT_MODEL,
        temperature: 0.2,
        messages
      })
    });

    if (!providerResponse.ok) {
      const errorText = await providerResponse.text();
      return res.status(providerResponse.status).json({
        error: 'Upstream provider error.',
        details: errorText.slice(0, 1200)
      });
    }

    const data = await providerResponse.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      return res.status(502).json({ error: 'No assistant content returned by provider.' });
    }

    const actionsParsed = parseJsonCodeBlock(content, 'study_actions');
    const testParsed = parseJsonCodeBlock(actionsParsed.cleanedContent, 'personalized_test');

    return res.json({
      reply: testParsed.cleanedContent,
      actions: actionsParsed.parsed?.actions || actionsParsed.parsed || [],
      personalizedTest: testParsed.parsed || null,
      usage: data?.usage || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'AI request failed.', details: error.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[Study AI] Running on http://localhost:${PORT}`);
});
