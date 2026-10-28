import { useEffect, useRef, useState } from 'react';
import { CloudIcon } from './CloudIcon';

interface Option {
  value: string;
  label: string;
  provider?: string;
}

interface CloudSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  showIcons?: boolean;
  style?: React.CSSProperties;
  minWidth?: number;
}

export function CloudSelect({
  value,
  onChange,
  options,
  placeholder = '— select —',
  showIcons = true,
  style,
  minWidth = 180,
}: CloudSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selected = options.find((o) => o.value === value);

  return (
    <div
      ref={ref}
      style={{ position: 'relative', minWidth, display: 'inline-block', ...style }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          minWidth,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          background: '#fff',
          fontSize: 13,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        {showIcons && selected?.provider && (
          <CloudIcon provider={selected.provider} size={16} />
        )}
        <span style={{ flex: 1, color: selected ? '#0f172a' : '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {selected?.label ?? placeholder}
        </span>
        <svg width="12" height="8" viewBox="0 0 12 8" style={{ flexShrink: 0 }}>
          <path
            fill="none"
            stroke="#64748b"
            strokeWidth="1.6"
            strokeLinecap="round"
            d="M1 1l5 5 5-5"
          />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: '100%',
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            boxShadow: '0 8px 24px -8px rgba(15, 23, 42, 0.15)',
            zIndex: 50,
            maxHeight: 260,
            overflowY: 'auto',
            padding: 4,
          }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                border: 'none',
                borderRadius: 6,
                background: opt.value === value ? '#eef2ff' : 'transparent',
                color: opt.value === value ? '#4f46e5' : '#0f172a',
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                if (opt.value !== value) e.currentTarget.style.background = '#f8fafc';
              }}
              onMouseLeave={(e) => {
                if (opt.value !== value) e.currentTarget.style.background = 'transparent';
              }}
            >
              {showIcons && opt.provider && <CloudIcon provider={opt.provider} size={16} />}
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}