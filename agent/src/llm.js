// @ts-check
// LLM client — Groq primary, Anthropic fallback.
//
// Both use the same tool-calling interface so the agent logic
// doesn't care which provider is active.

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',   // fallback if 70b quota exceeded
  'meta-llama/llama-4-scout-17b-16e-instruct',
];
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// ── Groq (OpenAI-compatible) ──────────────────────────────────────────────────

async function groqChat(messages, tools) {
  const Groq = require('groq-sdk');
  const groq = new Groq({ apiKey: GROQ_API_KEY });

  // Try models in order, fall back on rate limit
  let lastError;
  for (const model of GROQ_MODELS) {
    try {
      const res = await groq.chat.completions.create({
        model,
        messages,
        tools: tools || undefined,
        tool_choice: tools ? 'auto' : undefined,
        max_tokens: 1024,
        temperature: 0.3,
      });
      const choice = res.choices[0];
      return {
        content: choice.message.content || '',
        tool_calls: choice.message.tool_calls || [],
        finish_reason: choice.finish_reason,
        raw: choice.message,
      };
    } catch (err) {
      if (err?.status === 429 || err?.message?.includes('rate_limit')) {
        lastError = err;
        continue; // try next model
      }
      throw err;
    }
  }
  throw lastError || new Error('All Groq models rate-limited');
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function anthropicChat(messages, tools) {
  // Convert OpenAI-format tools to Anthropic format
  const anthropicTools = tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  // Anthropic needs system message separated
  const systemMsg = messages.find((m) => m.role === 'system');
  const chatMsgs = messages.filter((m) => m.role !== 'system');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY });

  const res = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: systemMsg?.content || '',
    messages: chatMsgs,
    tools: anthropicTools || undefined,
  });

  // Normalize to OpenAI format
  const textBlock = res.content.find((b) => b.type === 'text');
  const toolBlocks = res.content.filter((b) => b.type === 'tool_use');

  return {
    content: textBlock?.text || '',
    tool_calls: toolBlocks.map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    })),
    finish_reason: res.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    raw: res,
  };
}

// ── Unified interface ─────────────────────────────────────────────────────────

async function chat(messages, tools) {
  if (GROQ_API_KEY) {
    return groqChat(messages, tools);
  }
  if (ANTHROPIC_API_KEY) {
    return anthropicChat(messages, tools);
  }
  throw new Error('No LLM API key configured. Set GROQ_API_KEY or ANTHROPIC_API_KEY.');
}

function activeProvider() {
  if (GROQ_API_KEY) return `groq:${GROQ_MODELS[0]}`;
  if (ANTHROPIC_API_KEY) return `anthropic:${ANTHROPIC_MODEL}`;
  return 'none';
}

module.exports = { chat, activeProvider };
