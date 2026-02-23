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

function buildRuntimeContext(body) {
  return {
    timestampIso: new Date().toISOString(),
    mode: body?.mode || 'chat',
    testRequest: body?.testRequest || null,
    studentSnapshot: body?.studentSnapshot || {}
  };
}

function buildProviderMessages(runtimeContext, incomingMessages) {
  return [
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
}

function parseAssistantPayload(content) {
  const actionsParsed = parseJsonCodeBlock(content, 'study_actions');
  const testParsed = parseJsonCodeBlock(actionsParsed.cleanedContent, 'personalized_test');
  return {
    reply: testParsed.cleanedContent,
    actions: actionsParsed.parsed?.actions || actionsParsed.parsed || [],
    personalizedTest: testParsed.parsed || null
  };
}

function writeNdjson(res, payload) {
  res.write(JSON.stringify(payload) + '\n');
}

async function createProviderChatCompletion(messages, stream = false) {
  return fetch(`${OPENAI_COMPAT_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_COMPAT_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_COMPAT_MODEL,
      temperature: 0.2,
      stream,
      messages
    })
  });
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

    const runtimeContext = buildRuntimeContext(req.body);
    const messages = buildProviderMessages(runtimeContext, incomingMessages);
    const providerResponse = await createProviderChatCompletion(messages, false);

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

    const parsed = parseAssistantPayload(content);

    return res.json({
      reply: parsed.reply,
      actions: parsed.actions,
      personalizedTest: parsed.personalizedTest,
      usage: data?.usage || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'AI request failed.', details: error.message });
  }
});

app.post('/api/ai-teacher/chat/stream', async (req, res) => {
  try {
    if (!OPENAI_COMPAT_BASE_URL || !OPENAI_COMPAT_MODEL || !OPENAI_COMPAT_API_KEY) {
      return res.status(500).json({
        error: 'AI provider is not configured. Set OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_MODEL, and OPENAI_COMPAT_API_KEY in .env.'
      });
    }

    const incomingMessages = compactModelMessages(req.body?.messages);
    if (!incomingMessages.length) return res.status(400).json({ error: 'messages is required.' });

    const runtimeContext = buildRuntimeContext(req.body);
    const messages = buildProviderMessages(runtimeContext, incomingMessages);
    const providerResponse = await createProviderChatCompletion(messages, true);

    if (!providerResponse.ok) {
      const errorText = await providerResponse.text();
      return res.status(providerResponse.status).json({
        error: 'Upstream provider error.',
        details: errorText.slice(0, 1200)
      });
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    writeNdjson(res, { type: 'start' });

    const contentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
    let fullContent = '';

    // Fallback for providers that ignore stream=true and return JSON once.
    if (contentType.includes('application/json')) {
      const data = await providerResponse.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content) {
        fullContent = content;
        writeNdjson(res, { type: 'delta', delta: content });
      }
      const parsed = parseAssistantPayload(fullContent);
      writeNdjson(res, {
        type: 'final',
        reply: parsed.reply,
        actions: parsed.actions,
        personalizedTest: parsed.personalizedTest,
        usage: data?.usage || null
      });
      return res.end();
    }

    const reader = providerResponse.body?.getReader?.();
    if (!reader) throw new Error('No readable stream returned by provider.');
    const decoder = new TextDecoder();
    let buffer = '';

    const processLine = line => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) return false;
      const payload = trimmed.slice(5).trim();
      if (!payload) return false;
      if (payload === '[DONE]') return true;

      let chunk = null;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return false;
      }

      const delta =
        chunk?.choices?.[0]?.delta?.content ??
        chunk?.choices?.[0]?.message?.content ??
        chunk?.text ??
        '';

      if (typeof delta === 'string' && delta) {
        fullContent += delta;
        writeNdjson(res, { type: 'delta', delta });
      }
      return false;
    };

    let doneByMarker = false;
    while (!doneByMarker) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (processLine(line)) {
          doneByMarker = true;
          break;
        }
        idx = buffer.indexOf('\n');
      }
    }

    // Handle any tail line without newline.
    if (!doneByMarker && buffer.trim()) processLine(buffer);

    const parsed = parseAssistantPayload(fullContent);
    writeNdjson(res, {
      type: 'final',
      reply: parsed.reply,
      actions: parsed.actions,
      personalizedTest: parsed.personalizedTest
    });
    return res.end();
  } catch (error) {
    if (!res.headersSent) {
      return res.status(500).json({ error: 'AI stream request failed.', details: error.message });
    }
    try {
      writeNdjson(res, { type: 'error', error: 'AI stream request failed.', details: error.message });
    } catch { }
    return res.end();
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[Study AI] Running on http://localhost:${PORT}`);
});
