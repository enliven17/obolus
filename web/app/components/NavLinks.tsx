'use client';

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';


const LINKS: { href: string; label: string }[] = [
  { href: '/docs', label: 'Docs' },
  { href: '/dashboard', label: 'Dashboard' },
];

export function NavLinks() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          style={{
            textDecoration: 'none',
            color: isActive(l.href) ? 'var(--fg)' : 'var(--fg-muted)',
            fontSize: '0.84rem',
            fontFamily: 'var(--font-mono)',
            fontWeight: 500,
            padding: '0.45rem 0.8rem',
            borderRadius: 6,
            transition: 'color 0.2s',
          }}
        >
          {l.label}
        </Link>
      ))}

      <Link
        href="/dashboard"
        style={{
          marginLeft: '0.5rem',
          textDecoration: 'none',
          fontSize: '0.78rem',
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          padding: '0.5rem 1rem',
          borderRadius: 999,
          background: 'var(--fg)',
          color: 'var(--bg)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.4rem',
        }}
      >
        Launch
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path d="M2 7h10m-3.5-3.5L12 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>
    </div>
  );
}
