import type { CSSProperties } from 'react';

interface Props {
  height?: number;
  mark?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function Wordmark({ height = 28, className, style }: Props) {
  return (
    <span
      className={className}
      style={{
        fontFamily: 'var(--font-ruthie)',
        fontSize: height * 1.4,
        lineHeight: 1,
        color: 'var(--nav-accent, #F5AFAF)',
        letterSpacing: '0.01em',
        display: 'inline-block',
        userSelect: 'none',
        ...style,
      }}
    >
      Obolus
    </span>
  );
}
