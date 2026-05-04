'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NavLinks } from './NavLinks';
import { Wordmark } from './Wordmark';
import type { MouseEvent, ReactNode } from 'react';

export function MarketingChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const hideChrome = pathname.startsWith('/dashboard');

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (hideChrome) return <>{children}</>;

  return (
    <>
      <a href="#main" className="skip-link">Skip to main content</a>
      <div className="grain" aria-hidden />
      <nav
        className="marketing-nav"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          transition: 'background 0.35s ease, box-shadow 0.35s ease',
          background: scrolled ? 'rgba(252, 248, 248, 0.92)' : 'rgba(0,0,0,0)',
          backdropFilter: scrolled ? 'blur(16px) saturate(140%)' : 'none',
          WebkitBackdropFilter: scrolled ? 'blur(16px) saturate(140%)' : 'none',
          border: 'none',
          outline: 'none',
          boxShadow: scrolled ? '0 1px 0 0 #F9DFDF' : 'none',
        }}
      >
        <div style={{
          maxWidth: 1180, margin: '0 auto', padding: '0 1.35rem',
          height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <Link href="/" style={{ textDecoration: 'none', color: 'var(--fg)' }}>
            <Wordmark height={22} />
          </Link>
          <NavLinks />
        </div>
      </nav>

      <main id="main" style={{ flex: 1, position: 'relative', zIndex: 2, paddingTop: 64 }}>
        {children}
      </main>

      <footer style={{
        borderTop: '1px solid var(--border)',
        padding: '1.5rem 1.35rem',
        position: 'relative', zIndex: 2,
      }}>
        <div style={{
          maxWidth: 1180, margin: '0 auto',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: '0.75rem',
        }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)' }}>
            © {new Date().getFullYear()} Obolus · Solana devnet
          </span>
          <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
            <FooterLink href="/docs">Docs</FooterLink>
            <FooterLink href="/dashboard">Dashboard</FooterLink>
            <FooterLink href="https://solana.com" external>Solana</FooterLink>
          </div>
        </div>
      </footer>
    </>
  );
}

function FooterLink({ href, children, external }: { href: string; children: ReactNode; external?: boolean }) {
  return (
    <Link
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
      style={{
        color: 'var(--fg-dim)', textDecoration: 'none',
        fontSize: '0.78rem', fontFamily: 'var(--font-mono)',
        transition: 'color 0.2s',
      }}
      onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) => (e.currentTarget.style.color = 'var(--fg)')}
      onMouseLeave={(e: MouseEvent<HTMLAnchorElement>) => (e.currentTarget.style.color = 'var(--fg-dim)')}
    >
      {children}
    </Link>
  );
}
