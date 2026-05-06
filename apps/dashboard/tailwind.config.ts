import type { Config } from 'tailwindcss'

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Geist Sans"',
          'Inter',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        mono: [
          '"Geist Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        xs: ['11px', { lineHeight: '16px', letterSpacing: '0.005em' }],
        sm: ['13px', { lineHeight: '19px', letterSpacing: '0' }],
        base: ['14px', { lineHeight: '22px', letterSpacing: '0' }],
        md: ['16px', { lineHeight: '24px', letterSpacing: '-0.005em' }],
        lg: ['18px', { lineHeight: '26px', letterSpacing: '-0.01em' }],
        xl: ['22px', { lineHeight: '30px', letterSpacing: '-0.012em' }],
        '2xl': ['28px', { lineHeight: '36px', letterSpacing: '-0.018em' }],
        '3xl': ['36px', { lineHeight: '44px', letterSpacing: '-0.022em' }],
      },
      colors: {
        // CSS-variable backed (defined in index.css). Each token resolves at
        // runtime so light/dark theme just flips the `:root` block.
        bg: 'oklch(var(--bg-l) var(--bg-c) var(--bg-h))',
        surface: 'oklch(var(--surface-l) var(--surface-c) var(--surface-h))',
        'surface-2': 'oklch(var(--surface-2-l) var(--surface-2-c) var(--surface-2-h))',
        'surface-3': 'oklch(var(--surface-3-l) var(--surface-3-c) var(--surface-3-h))',
        line: 'oklch(var(--line-l) var(--line-c) var(--line-h))',
        'line-strong':
          'oklch(var(--line-strong-l) var(--line-strong-c) var(--line-strong-h))',
        ink: 'oklch(var(--ink-l) var(--ink-c) var(--ink-h))',
        'ink-muted': 'oklch(var(--ink-muted-l) var(--ink-muted-c) var(--ink-muted-h))',
        'ink-dim': 'oklch(var(--ink-dim-l) var(--ink-dim-c) var(--ink-dim-h))',
        'ink-inv': 'oklch(var(--ink-inv-l) var(--ink-inv-c) var(--ink-inv-h))',
        accent: 'oklch(var(--accent-l) var(--accent-c) var(--accent-h))',
        'accent-hi': 'oklch(var(--accent-hi-l) var(--accent-hi-c) var(--accent-hi-h))',
        'accent-lo': 'oklch(var(--accent-lo-l) var(--accent-lo-c) var(--accent-lo-h))',
        ok: 'oklch(var(--ok-l) var(--ok-c) var(--ok-h))',
        warn: 'oklch(var(--warn-l) var(--warn-c) var(--warn-h))',
        bad: 'oklch(var(--bad-l) var(--bad-c) var(--bad-h))',
        info: 'oklch(var(--info-l) var(--info-c) var(--info-h))',
      },
      borderRadius: {
        DEFAULT: '6px',
        lg: '8px',
        xl: '10px',
        '2xl': '14px',
      },
      boxShadow: {
        'inset-hi': 'inset 0 1px 0 rgba(255,255,255,0.06)',
        'ring-accent': '0 0 0 2px oklch(var(--accent-l) var(--accent-c) var(--accent-h) / 0.45)',
      },
      transitionTimingFunction: {
        'out-quart': 'cubic-bezier(0.22, 1, 0.36, 1)',
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': {
            transform: 'scale(1)',
            opacity: '1',
          },
          '50%': {
            transform: 'scale(1.18)',
            opacity: '0.55',
          },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-rail': {
          '0%': { transform: 'translateX(8px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.6s cubic-bezier(0.22, 1, 0.36, 1) infinite',
        'fade-up': 'fade-up 0.32s cubic-bezier(0.22, 1, 0.36, 1) forwards',
        'fade-in': 'fade-in 0.18s cubic-bezier(0.22, 1, 0.36, 1) forwards',
        'slide-rail': 'slide-rail 0.32s cubic-bezier(0.22, 1, 0.36, 1) forwards',
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
} satisfies Config
