// @ts-check
// Obolus agent tools — what the AI can do.

const BACKEND_URL = process.env.OBOLUS_BACKEND_URL || 'http://localhost:4000';
const DEMO_STORE_URL = process.env.DEMO_STORE_URL || 'http://localhost:3001';

function getApiKey() {
  return process.env.OBOLUS_API_KEY || '';
}

async function backendFetch(path, opts = {}) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': getApiKey(),
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
  return body;
}

// ── Tool definitions (OpenAI function-calling format) ─────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'check_budget',
      description: 'Check current spending budget — spent and remaining. Call before every purchase.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_services',
      description: 'List available services with prices (Vercel, OpenAI, GitHub, AWS).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'purchase_service',
      description: 'Purchase a service using a virtual Visa card. Creates Solana payment, waits for card, completes purchase.',
      parameters: {
        type: 'object',
        properties: {
          service_id: {
            type: 'string',
            description: 'Service to buy',
            enum: ['vercel-pro', 'openai-credits', 'github-pro', 'aws-credits'],
          },
          reason: {
            type: 'string',
            description: 'Reason for purchase (for transparency log)',
          },
        },
        required: ['service_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
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
    type: 'function',
    function: {
      name: 'get_order_status',
      description: 'Check the status of a card order.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
        },
        required: ['order_id'],
      },
    },
  },
];

// ── Tool implementations ──────────────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {
    case 'check_budget': {
      const usage = await backendFetch('/v1/usage');
      return {
        spent_usdc: usage.budget?.spent_usdc || '0',
        limit_usdc: usage.budget?.limit_usdc || 'unlimited',
        remaining_usdc: usage.budget?.remaining_usdc || 'unlimited',
        total_orders: usage.orders?.total || 0,
        delivered_orders: usage.orders?.delivered || 0,
      };
    }

    case 'list_services': {
      const res = await fetch(`${DEMO_STORE_URL}/services`, {
        signal: AbortSignal.timeout(5000),
      });
      const services = await res.json();
      return { services };
    }

    case 'purchase_service': {
      const { service_id, reason } = args;

      // Get service price
      const servicesRes = await fetch(`${DEMO_STORE_URL}/services`);
      const services = await servicesRes.json();
      const service = services.find((s) => s.id === service_id);
      if (!service) throw new Error(`Unknown service: ${service_id}`);

      const amountUsdc = (service.price / 100).toFixed(2);

      // Create order
      const order = await backendFetch('/v1/orders', {
        method: 'POST',
        body: JSON.stringify({
          amount_usdc: amountUsdc,
          metadata: { service_id, reason, agent: true },
        }),
        headers: { 'Idempotency-Key': `agent-${service_id}-${Date.now()}` },
      });

      // In dev mode: simulate Solana payment automatically
      if (process.env.NODE_ENV !== 'production') {
        await fetch(`${BACKEND_URL}/dev/simulate-payment/${order.order_id}`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }

      // Poll for card (max 60s)
      let card = null;
      const startedAt = Date.now();
      while (Date.now() - startedAt < 60000) {
        await new Promise((r) => setTimeout(r, 3000));
        const status = await backendFetch(`/v1/orders/${order.order_id}`);
        if (status.phase === 'ready' && status.card) {
          card = status.card;
          break;
        }
        if (['failed', 'refunded', 'expired'].includes(status.phase)) {
          throw new Error(`Order ${status.phase}: ${status.error || 'unknown'}`);
        }
      }
      if (!card) throw new Error('Card delivery timed out');

      // Use card at demo store
      const purchaseRes = await fetch(`${DEMO_STORE_URL}/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service_id, card, order_id: order.order_id }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await purchaseRes.json();
      if (!result.success) throw new Error(result.error || 'Purchase failed');

      return {
        success: true,
        service: result.service,
        amount: result.receipt?.amount,
        card_last4: result.receipt?.card_last4,
        order_id: order.order_id,
      };
    }

    case 'get_spending_report': {
      const orders = await backendFetch('/v1/orders');
      const days = args.days || 30;
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
      return backendFetch(`/v1/orders/${args.order_id}`);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
