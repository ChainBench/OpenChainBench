export const PUBLIC_PER_MINUTE = {
  capital: 120,
  citable: 60,
  "citable-date": 60,
  cite: 60,
  compare: 60,
  freshness: 120,
  "llm-context": 30,
  og: 60,
  sparkline: 120,
  stat: 60,
} as const;

export type PublicRoute = keyof typeof PUBLIC_PER_MINUTE;

const capacities: number[] = Object.values(PUBLIC_PER_MINUTE);

export const PUBLIC_RANGE =
  `${Math.min(...capacities)} to ${Math.max(...capacities)}`;
