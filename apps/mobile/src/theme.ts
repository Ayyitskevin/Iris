/** Minimal design tokens. One place to make Iris feel like Iris. */
export const theme = {
  colors: {
    bg: '#0e0f13',
    surface: '#181a20',
    surfaceAlt: '#20232c',
    border: '#2a2e39',
    text: '#f2f3f5',
    textDim: '#9aa0ac',
    accent: '#7c9cff', // the iris blue
    accentDim: '#3a4a80',
    danger: '#ff6b6b',
    agent: '#c58bff', // agents get their own hue in the feed
  },
  space: (n: number) => n * 4,
  radius: 12,
} as const;

export type Theme = typeof theme;
