/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0d0d0d',
        surface: '#111111',
        border: '#222222',
        accent: '#10b981',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'],
      },
    },
  },
  plugins: [],
}
