'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useEffect, useState } from 'react';
import { Wordmark } from '@/app/components/Wordmark';

export function AuthGate() {
  const { login, ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Privy login tamamlandıktan sonra backend session oluştur
  useEffect(() => {
    if (!ready || !authenticated || !user) return;

    const email = user.email?.address || user.google?.email || user.twitter?.username + '@twitter.com';
    if (!email) return;

    setLinking(true);
    setError(null);

    (async () => {
      try {
        const token = await getAccessToken();
        const res = await fetch('/api/auth/privy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: token, email }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.message || data?.error || 'Session creation failed');
        }
        // Backend session cookie set edildi — dashboard'u yükle
        window.location.reload();
      } catch (err) {
        setError((err as Error).message);
        setLinking(false);
        // Privy'den de logout yap
        await logout();
      }
    })();
  }, [ready, authenticated, user]);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
      padding: '1.5rem',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 360,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        padding: '2.5rem 2rem',
        boxShadow: 'var(--shadow-card)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '1.5rem',
      }}>
        <Wordmark height={28} />

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>
            Dashboard
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--fg-dim)' }}>
            Sign in to manage your AI agent treasury
          </div>
        </div>

        {linking ? (
          <div style={{ fontSize: '0.82rem', color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)' }}>
            Setting up session…
          </div>
        ) : (
          <button
            onClick={login}
            disabled={!ready}
            style={{
              width: '100%',
              padding: '0.75rem 1.5rem',
              borderRadius: 999,
              background: '#2D2D2D',
              color: '#FCF8F8',
              border: 'none',
              fontSize: '0.88rem',
              fontWeight: 600,
              fontFamily: 'var(--font-mono)',
              cursor: ready ? 'pointer' : 'not-allowed',
              opacity: ready ? 1 : 0.6,
              transition: 'opacity 0.2s',
            }}
          >
            Sign in
          </button>
        )}

        {error && (
          <div style={{
            fontSize: '0.72rem',
            color: 'var(--red)',
            padding: '0.55rem 0.7rem',
            background: 'var(--red-muted)',
            border: '1px solid var(--red-border)',
            borderRadius: 6,
            width: '100%',
            textAlign: 'center',
          }}>
            {error}
          </div>
        )}

        <div style={{ fontSize: '0.68rem', color: 'var(--fg-dim)', textAlign: 'center' }}>
          Email · Google · Twitter · Phantom
        </div>
      </div>
    </div>
  );
}
