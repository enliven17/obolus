// @ts-check
// Obolus AI Agent — autonomous spending via tool-calling loop.
//
// Flow:
//   1. User sends message ("buy Vercel hosting")
//   2. LLM decides which tools to call
//   3. Tools execute (check budget → create order → wait for card → purchase)
//   4. Results fed back to LLM
//   5. LLM generates final response
//
// Uses Groq (free, fast) with Anthropic fallback.

const { chat } = require('./llm');
const { TOOL_DEFINITIONS, executeTool } = require('./tools');

const SYSTEM_PROMPT = `You are the Obolus spending agent. You autonomously manage development infrastructure purchases for funded projects on Solana.

Your capabilities:
- Check the project's spending budget
- Purchase developer services (Vercel, OpenAI, GitHub, AWS) using virtual Visa cards
- Generate spending reports for community transparency

Rules:
- ALWAYS check budget before purchasing
- Be concise — one action at a time
- If budget is insufficient, explain clearly and don't proceed
- After a purchase, confirm what was bought and the amount
- Keep responses short and action-focused

When asked to buy something:
1. Check budget
2. List services to find the right one
3. Purchase it
4. Confirm the result`;

/**
 * Run the agent with a user message.
 * Returns an async generator that yields { type, content } events.
 *
 * @param {string} userMessage
 * @param {Array<{role: string, content: string}>} history - conversation history
 */
async function* runAgent(userMessage, history = []) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage },
  ];

  yield { type: 'thinking', content: '...' };

  let iterationCount = 0;
  const MAX_ITERATIONS = 6;

  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;

    const response = await chat(messages, TOOL_DEFINITIONS);

    // Stream text content if any
    if (response.content) {
      yield { type: 'text', content: response.content };
    }

    // No tool calls → done
    if (!response.tool_calls?.length || response.finish_reason === 'stop') {
      break;
    }

    // Execute each tool call
    for (const toolCall of response.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs = {};
      try {
        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch { /* empty args */ }

      yield { type: 'tool_start', tool: toolName, args: toolArgs };

      let toolResult;
      try {
        toolResult = await executeTool(toolName, toolArgs);
        yield { type: 'tool_result', tool: toolName, result: toolResult };
      } catch (err) {
        toolResult = { error: err.message };
        yield { type: 'tool_error', tool: toolName, error: err.message };
      }

      // Add assistant message with tool call
      messages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls,
      });

      // Add tool result
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  if (iterationCount >= MAX_ITERATIONS) {
    yield { type: 'text', content: 'Reached maximum steps. Please try a more specific request.' };
  }
}

/**
 * Simple one-shot run (non-streaming) — collects all events and returns final text.
 * @param {string} userMessage
 * @param {Array} history
 */
async function runAgentOnce(userMessage, history = []) {
  const events = [];
  let finalText = '';

  for await (const event of runAgent(userMessage, history)) {
    events.push(event);
    if (event.type === 'text') finalText += event.content;
  }

  return { text: finalText, events };
}

module.exports = { runAgent, runAgentOnce };
