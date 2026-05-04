// @ts-check
// Obolus Agent HTTP server — exposes the AI agent as a REST + SSE API.
//
// POST /chat         → one-shot request/response
// POST /chat/stream  → SSE stream of agent events (thinking, tool calls, text)
// GET  /status       → agent health + active LLM provider

const express = require('express');
const { runAgent, runAgentOnce } = require('./agent');
const { activeProvider } = require('./llm');

const PORT = process.env.AGENT_PORT || 3002;
const app = express();
app.use(express.json());

// Conversation history per session (in-memory, keyed by session_id)
const sessions = new Map();

function getHistory(sessionId) {
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  return sessions.get(sessionId);
}

function pushHistory(sessionId, role, content) {
  const history = getHistory(sessionId);
  history.push({ role, content });
  // Keep last 20 messages to avoid context overflow
  if (history.length > 20) history.splice(0, history.length - 20);
}

// GET /status
app.get('/status', (_req, res) => {
  res.json({
    ok: true,
    provider: activeProvider(),
    backend: process.env.OBOLUS_BACKEND_URL || 'http://localhost:4000',
    store: process.env.DEMO_STORE_URL || 'http://localhost:3001',
  });
});

// POST /chat — one-shot, waits for full response
// Body: { message, session_id? }
app.post('/chat', async (req, res) => {
  const { message, session_id = 'default' } = req.body;
  if (!message) return res.status(400).json({ error: 'missing_message' });

  const history = getHistory(session_id);

  try {
    const { text, events } = await runAgentOnce(message, history);

    // Persist to history
    pushHistory(session_id, 'user', message);
    pushHistory(session_id, 'assistant', text);

    res.json({ reply: text, events, session_id });
  } catch (err) {
    console.error('[agent] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /chat/stream — SSE stream
// Body: { message, session_id? }
app.post('/chat/stream', async (req, res) => {
  const { message, session_id = 'default' } = req.body;
  if (!message) return res.status(400).json({ error: 'missing_message' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const history = getHistory(session_id);
  let fullText = '';

  try {
    for await (const event of runAgent(message, history)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'text') fullText += event.content;
    }

    pushHistory(session_id, 'user', message);
    pushHistory(session_id, 'assistant', fullText);

    res.write(`data: ${JSON.stringify({ type: 'done', session_id })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  }

  res.end();
});

// DELETE /chat/:session_id — clear conversation history
app.delete('/chat/:session_id', (req, res) => {
  sessions.delete(req.params.session_id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[agent] running on port ${PORT}`);
  console.log(`[agent] provider: ${activeProvider()}`);
  console.log(`[agent] backend: ${process.env.OBOLUS_BACKEND_URL || 'http://localhost:4000'}`);
});
