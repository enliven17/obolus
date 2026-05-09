'use client';

import { useState, useEffect } from 'react';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { Card } from '../_ui/Card';
import { useDashboard } from '../_lib/DashboardProvider';

interface FeedEntry {
  order_id: string;
  amount_usdc: string;
  card_brand?: string;
  solana_txid?: string;
  completed_at: string;
  service?: string;
  metadata?: { service_id?: string };
}

const SERVICE_ICONS: Record<string, string> = {
  'vercel-pro': '▲',
  'openai-credits': '🤖',
  'github-pro': '🐙',
  'aws-credits': '☁️',
};

const SERVICE_NAMES: Record<string, string> = {
  'vercel-pro': 'Vercel Pro',
  'openai-credits': 'OpenAI Credits',
  'github-pro': 'GitHub Pro',
  'aws-credits': 'AWS Credits',
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function FeedPage() {
  const { orders } = useDashboard();
  const [feed, setFeed] = useState<FeedEntry[]>([]);

  useEffect(() => {
    // Build feed from delivered orders
    const delivered = orders
      .filter((o) => o.status === 'delivered')
      .map((o) => ({
        order_id: o.id,
        amount_usdc: o.amount_usdc,
        card_brand: o.card_brand ?? undefined,
        solana_txid: o.solana_txid ?? undefined,
        completed_at: o.updated_at || o.created_at,
        metadata: o.metadata,
      }))
      .sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime());
    setFeed(delivered);
  }, [orders]);

  const totalSpent = feed.reduce((s, e) => s + parseFloat(e.amount_usdc || '0'), 0);

  return (
    <PageContainer>
      <PageHeader
        title="Spending Feed"
        subtitle="Every agent purchase — transparent and on-chain"
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Stats row */}
        <div style={{ display: 'flex', gap: 12 }}>
          {[
            { label: 'Total Spent', value: `$${totalSpent.toFixed(2)}` },
            { label: 'Purchases', value: String(feed.length) },
            { label: 'Payment', value: 'Solana USDC' },
          ].map(({ label, value }) => (
            <Card key={label} style={{ flex: 1, padding: '14px 18px' }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--fg-dim)', marginBottom: 4 }}>
                {label}
              </div>
              <div style={{ fontSize: '1.2rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                {value}
              </div>
            </Card>
          ))}
        </div>

        {/* Feed */}
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {feed.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: 'center',
                color: 'var(--fg-dim)',
                fontSize: '0.85rem',
              }}
            >
              No purchases yet. Ask the agent to buy something.
            </div>
          ) : (
            <div>
              {feed.map((entry, i) => {
                const serviceId = entry.metadata?.service_id;
                const icon = serviceId ? SERVICE_ICONS[serviceId] : '💳';
                const name = serviceId ? SERVICE_NAMES[serviceId] : 'Service Purchase';
                const explorerUrl = entry.solana_txid?.startsWith('devnet_sim')
                  ? null
                  : `https://explorer.solana.com/tx/${entry.solana_txid}?cluster=devnet`;

                return (
                  <div
                    key={entry.order_id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 14,
                      padding: '14px 20px',
                      borderBottom: i < feed.length - 1 ? '1px solid var(--border)' : 'none',
                    }}
                  >
                    {/* Icon */}
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 8,
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '1rem',
                        flexShrink: 0,
                      }}
                    >
                      {icon}
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{name}</div>
                      <div
                        style={{
                          fontSize: '0.73rem',
                          color: 'var(--fg-dim)',
                          fontFamily: 'var(--font-mono)',
                          marginTop: 2,
                        }}
                      >
                        {entry.order_id.slice(0, 8)}…{entry.card_brand && ` · ${entry.card_brand}`}
                      </div>
                    </div>

                    {/* Amount */}
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: '0.9rem',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        ${parseFloat(entry.amount_usdc).toFixed(2)}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--fg-dim)' }}>
                        {timeAgo(entry.completed_at)}
                      </div>
                    </div>

                    {/* Solana link */}
                    {explorerUrl ? (
                      <a
                        href={explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: '0.7rem',
                          color: 'var(--fg-dim)',
                          fontFamily: 'var(--font-mono)',
                          textDecoration: 'none',
                          flexShrink: 0,
                          padding: '3px 8px',
                          borderRadius: 4,
                          border: '1px solid var(--border)',
                          background: 'var(--surface)',
                        }}
                        title="View on Solana Explorer"
                      >
                        ↗ tx
                      </a>
                    ) : (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          color: 'var(--fg-dim)',
                          fontFamily: 'var(--font-mono)',
                          flexShrink: 0,
                          padding: '3px 8px',
                          borderRadius: 4,
                          border: '1px solid var(--border)',
                          background: 'var(--surface)',
                        }}
                      >
                        devnet sim
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
