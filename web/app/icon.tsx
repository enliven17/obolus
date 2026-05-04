import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#FCF8F8',
          borderRadius: 8,
        }}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 32 32"
          fill="none"
        >
          <circle cx="16" cy="16" r="13" stroke="#F5AFAF" strokeWidth="2.5" />
          <ellipse cx="16" cy="16" rx="5.5" ry="9.5" stroke="#F5AFAF" strokeWidth="2.5" />
          <line x1="4" y1="16" x2="28" y2="16" stroke="#F5AFAF" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
