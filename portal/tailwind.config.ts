import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // LavaVPS brand palette
        lava: {
          50:  '#FFF0ED',
          100: '#FFD9D1',
          200: '#FFB3A3',
          300: '#FF8066',
          400: '#FF4D1F',
          500: '#CC2200',   // primary
          600: '#A31A00',
          700: '#7A1200',
          800: '#520B00',
          900: '#290500',
        },
        ember: {
          50:  '#FFF8ED',
          100: '#FFE9C2',
          200: '#FFD085',
          300: '#FFBA47',
          400: '#FFA000',   // warning/highlight
          500: '#E08000',
        },
        obsidian: {
          50:  '#F5F5F7',
          100: '#E8E8EC',
          200: '#C8C8D4',
          300: '#9898A8',
          400: '#606070',
          500: '#3A3A4A',
          600: '#242432',
          700: '#18181F',   // card bg
          800: '#111116',   // surface
          900: '#0A0A0E',   // deepest
          950: '#060608',   // bg
        },
        surface: '#111116',
        card:    '#18181F',
        border:  '#242432',
        muted:   '#606070',
        text:    '#E8E8EC',
      },
      fontFamily: {
        sans: ['DM Sans', 'ui-sans-serif', 'system-ui'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
        display: ['Syne', 'DM Sans', 'ui-sans-serif'],
      },
      boxShadow: {
        'lava-sm': '0 0 8px rgba(204, 34, 0, 0.15)',
        'lava':    '0 0 20px rgba(204, 34, 0, 0.2)',
        'lava-lg': '0 0 40px rgba(204, 34, 0, 0.25)',
        'card':    '0 1px 3px rgba(0,0,0,0.4), 0 4px 12px rgba(0,0,0,0.3)',
      },
      animation: {
        'pulse-lava': 'pulse-lava 2s ease-in-out infinite',
        'slide-up':   'slide-up 0.3s ease-out',
        'slide-in':   'slide-in 0.25s ease-out',
        'fade-in':    'fade-in 0.2s ease-out',
        'spin-slow':  'spin 3s linear infinite',
        'typing':     'typing 1.2s steps(3) infinite',
      },
      keyframes: {
        'pulse-lava': {
          '0%, 100%': { boxShadow: '0 0 8px rgba(204,34,0,0.15)' },
          '50%':       { boxShadow: '0 0 20px rgba(204,34,0,0.4)' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to:   { opacity: '1', transform: 'translateX(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        'typing': {
          '0%':   { content: "''" },
          '33%':  { content: "'.'" },
          '66%':  { content: "'..'" },
          '100%': { content: "'...'" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
