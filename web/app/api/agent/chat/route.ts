// POST /api/agent/chat
// Streams agent events as SSE. History is managed client-side and sent
// with each request — no server-side session state needed for Vercel.

import type { NextRequest } from 'next/server';
import Groq from 'groq-sdk';

export const runtime = 'nodejs';
export const maxDuration = 60;

const BACKEND_URL = (
  process.env.OBOLUS_BACKEND_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  'http://localhost:4000'
).replace(/\/$/, '');

const GROQ_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

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
- Keep responses short and action-focused`;

const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'check_budget',
      description:
        'Check current spending budget — spent and remaining. Call before every purchase.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_spending_report',
      description: 'Get summary of recent spending.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Days back to report (default: 30)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_order_status',
      description: 'Check the status of a card order.',
      parameters: {
        type: 'object',
        properties: { order_id: { type: 'string' } },
        required: ['order_id'],
      },
    },
  },
];

async function backendFetch(path: string, apiKey: string, opts: RequestInit = {}) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      ...((opts.headers as Record<string, string>) || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  if (!res.ok)
    throw new Error((body as { error?: string; message?: string }).error || `HTTP ${res.status}`);
  return body;
}

async function executeTool(name: string, args: Record<string, unknown>, apiKey: string) {
  switch (name) {
    case 'check_budget': {
      const usage = (await backendFetch('/v1/usage', apiKey)) as {
        budget?: { spent_usdc?: string; limit_usdc?: string; remaining_usdc?: string };
        orders?: { total?: number; delivered?: number };
      };
      return {
        spent_usdc: usage.budget?.spent_usdc || '0',
        limit_usdc: usage.budget?.limit_usdc || 'unlimited',
        remaining_usdc: usage.budget?.remaining_usdc || 'unlimited',
        total_orders: usage.orders?.total || 0,
        delivered_orders: usage.orders?.delivered || 0,
      };
    }
    case 'get_spending_report': {
      const orders = (await backendFetch('/v1/orders', apiKey)) as {
        orders?: Array<{
          status: string;
          created_at: string;
          amount_usdc?: string;
          metadata?: { service_id?: string };
        }>;
      };
      const days = (args.days as number) || 30;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const recent = (orders.orders || []).filter((o) => o.created_at >= cutoff);
      const delivered = recent.filter((o) => o.status === 'delivered');
      const totalSpent = delivered.reduce((sum, o) => sum + parseFloat(o.amount_usdc || '0'), 0);
      return {
        period_days: days,
        total_orders: recent.length,
        delivered: delivered.length,
        total_spent_usdc: totalSpent.toFixed(2),
        recent_purchases: delivered.slice(0, 5).map((o) => ({
          service: o.metadata?.service_id || 'unknown',
          amount: o.amount_usdc,
          date: o.created_at?.slice(0, 10),
        })),
      };
    }
    case 'get_order_status': {
      return backendFetch(`/v1/orders/${args.order_id}`, apiKey);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function* runAgent(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  apiKey: string,
): AsyncGenerator<Record<string, unknown>> {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage },
  ];

  yield { type: 'thinking', content: '...' };

  let iter = 0;
  while (iter++ < 6) {
    let res;
    let lastErr;
    for (const model of GROQ_MODELS) {
      try {
        res = await groq.chat.completions.create({
          model,
          messages: messages as unknown as Parameters<
            typeof groq.chat.completions.create
          >[0]['messages'],
          tools: TOOL_DEFINITIONS,
          tool_choice: 'auto',
          max_tokens: 1024,
          temperature: 0.3,
        });
        break;
      } catch (err) {
        const e = err as { status?: number; message?: string };
        if (e?.status === 429 || e?.message?.includes('rate_limit')) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    if (!res) throw lastErr || new Error('All Groq models rate-limited');

    const choice = res.choices[0];
    if (choice.message.content) yield { type: 'text', content: choice.message.content };
    if (!choice.message.tool_calls?.length || choice.finish_reason === 'stop') break;

    for (const call of choice.message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* empty */
      }

      yield { type: 'tool_start', tool: call.function.name, args };

      let result;
      try {
        result = await executeTool(call.function.name, args, apiKey);
        yield { type: 'tool_result', tool: call.function.name, result };
      } catch (err) {
        result = { error: (err as Error).message };
        yield { type: 'tool_error', tool: call.function.name, error: (err as Error).message };
      }

      messages.push({
        role: 'assistant',
        content: choice.message.content || '',
        tool_calls: choice.message.tool_calls,
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    message?: string;
    history?: Array<{ role: string; content: string }>;
    api_key?: string;
  };

  const { message, history = [], api_key } = body;
  if (!message) return Response.json({ error: 'missing_message' }, { status: 400 });

  const agentApiKey = api_key || process.env.OBOLUS_AGENT_API_KEY || '';
  if (!agentApiKey)
    return Response.json(
      { error: 'agent_not_configured', message: 'Set OBOLUS_AGENT_API_KEY in Vercel env vars' },
      { status: 503 },
    );
  if (!process.env.GROQ_API_KEY)
    return Response.json(
      { error: 'llm_not_configured', message: 'Set GROQ_API_KEY in Vercel env vars' },
      { status: 503 },
    );

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        for await (const event of runAgent(message, history, agentApiKey)) {
          send(event);
        }
        send({ type: 'done' });
      } catch (err) {
        send({ type: 'error', error: (err as Error).message });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
