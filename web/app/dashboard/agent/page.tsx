'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { Card } from '../_ui/Card';

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL || 'http://localhost:3002';

interface AgentEvent {
  type: 'thinking' | 'tool_start' | 'tool_result' | 'tool_error' | 'text' | 'done' | 'error';
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  events?: AgentEvent[];
  loading?: boolean;
}

const SUGGESTIONS = [
  'What is my current spending budget?',
  'Buy GitHub Pro for the project',
  'Purchase OpenAI API credits',
  'Show me my spending report',
  'Buy Vercel Pro hosting',
];

function ToolBadge({ event }: { event: AgentEvent }) {
  const toolLabels: Record<string, string> = {
    check_budget: '💰 Checking budget',
    list_services: '🛍️ Listing services',
    purchase_service: '💳 Purchasing',
    get_spending_report: '📊 Getting report',
    get_order_status: '🔍 Checking order',
  };

  if (event.type === 'tool_start') {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 10px',
          borderRadius: 20,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          fontSize: '0.73rem',
          color: 'var(--fg-dim)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
        {toolLabels[event.tool || ''] || event.tool}
        {event.tool === 'purchase_service' &&
          event.args?.service_id !== null &&
          event.args?.service_id !== undefined && (
            <span style={{ color: 'var(--fg)' }}>
              — {String((event.args as Record<string, unknown>).service_id)}
            </span>
          )}
      </div>
    );
  }

  if (event.type === 'tool_result' && event.tool === 'purchase_service') {
    const r = event.result as {
      success?: boolean;
      service?: string;
      amount?: string;
      card_last4?: string;
    };
    if (r?.success) {
      return (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px',
            borderRadius: 20,
            background: 'rgba(34,197,94,0.1)',
            border: '1px solid rgba(34,197,94,0.3)',
            fontSize: '0.73rem',
            color: '#22c55e',
            fontFamily: 'var(--font-mono)',
          }}
        >
          ✓ {r.service} {r.amount} · card ****{r.card_last4}
        </div>
      );
    }
  }

  if (event.type === 'tool_error') {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 10px',
          borderRadius: 20,
          background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.3)',
          fontSize: '0.73rem',
          color: '#ef4444',
          fontFamily: 'var(--font-mono)',
        }}
      >
        ✗ {event.tool}: {event.error}
      </div>
    );
  }

  return null;
}

function AssistantMessage({ message }: { message: Message }) {
  const toolEvents = (message.events || []).filter(
    (e) => e.type === 'tool_start' || e.type === 'tool_result' || e.type === 'tool_error',
  );

  // Dedupe: only show tool_start if no corresponding tool_result
  const shown = toolEvents.filter((e, i) => {
    if (e.type !== 'tool_start') return true;
    return !toolEvents.slice(i + 1).some((r) => r.tool === e.tool && r.type === 'tool_result');
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '80%' }}>
      {shown.map((ev, i) => (
        <ToolBadge key={i} event={ev} />
      ))}
      {message.loading ? (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '12px 12px 12px 2px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            fontSize: '0.85rem',
            color: 'var(--fg-dim)',
            display: 'flex',
            gap: 4,
            alignItems: 'center',
          }}
        >
          <span style={{ opacity: 0.5 }}>●</span>
          <span style={{ opacity: 0.7 }}>●</span>
          <span>●</span>
        </div>
      ) : message.content ? (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '12px 12px 12px 2px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            fontSize: '0.85rem',
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
          }}
        >
          {message.content}
        </div>
      ) : null}
    </div>
  );
}

export default function AgentPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content:
        "Hi! I'm your Obolus spending agent. I can check your budget, purchase developer services (Vercel, GitHub, OpenAI, AWS), and generate spending reports. What would you like to do?",
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(() => `session-${Date.now()}`);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || loading) return;

      const userMsg: Message = { role: 'user', content: text };
      const assistantMsg: Message = { role: 'assistant', content: '', loading: true, events: [] };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');
      setLoading(true);

      try {
        const res = await fetch(`${AGENT_URL}/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, session_id: sessionId }),
        });

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event: AgentEvent = JSON.parse(line.slice(6));
              setMessages((prev) => {
                const msgs = [...prev];
                const last = { ...msgs[msgs.length - 1] };
                if (event.type === 'text') {
                  last.content = (last.content || '') + event.content;
                } else if (event.type === 'done') {
                  last.loading = false;
                } else if (event.type === 'error') {
                  last.content = `Error: ${event.error}`;
                  last.loading = false;
                } else {
                  last.events = [...(last.events || []), event];
                }
                msgs[msgs.length - 1] = last;
                return msgs;
              });
            } catch {
              /* skip malformed */
            }
          }
        }
      } catch (_err) {
        setMessages((prev) => {
          const msgs = [...prev];
          msgs[msgs.length - 1] = {
            role: 'assistant',
            content: 'Connection error. Is the agent service running on port 3002?',
            loading: false,
          };
          return msgs;
        });
      } finally {
        setLoading(false);
      }
    },
    [loading, sessionId],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    send(input);
  };

  return (
    <PageContainer>
      <PageHeader title="AI Agent" subtitle="Autonomous spending powered by Groq Llama" />

      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 16, height: 'calc(100vh - 160px)' }}
      >
        {/* Chat messages */}
        <Card
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {messages.map((msg, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              {msg.role === 'user' ? (
                <div
                  style={{
                    maxWidth: '70%',
                    padding: '10px 14px',
                    borderRadius: '12px 12px 2px 12px',
                    background: 'var(--accent, #7c3aed)',
                    color: '#fff',
                    fontSize: '0.85rem',
                    lineHeight: 1.5,
                  }}
                >
                  {msg.content}
                </div>
              ) : (
                <AssistantMessage message={msg} />
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </Card>

        {/* Suggestions */}
        {messages.length <= 1 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={loading}
                style={{
                  padding: '6px 12px',
                  borderRadius: 20,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--fg-muted)',
                  fontSize: '0.78rem',
                  cursor: 'pointer',
                  transition: 'border-color 120ms',
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 10 }}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask agent to purchase a service, check budget..."
            disabled={loading}
            style={{
              flex: 1,
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--fg)',
              fontSize: '0.85rem',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              background: loading ? 'var(--surface)' : 'var(--accent, #7c3aed)',
              color: loading ? 'var(--fg-dim)' : '#fff',
              border: '1px solid var(--border)',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'background 120ms',
            }}
          >
            {loading ? '...' : 'Send'}
          </button>
        </form>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </PageContainer>
  );
}
