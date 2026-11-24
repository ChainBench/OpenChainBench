import { KEYED_PER_MINUTE } from "./contract";

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

const capacities: number[] = Object.values(PUBLIC_PER_MINUTE);

export const PUBLIC_RANGE =
  `${Math.min(...capacities)} to ${Math.max(...capacities)}`;

export type PublicRoute = keyof typeof PUBLIC_PER_MINUTE;

const KEYED_COSTLY: Partial<Record<PublicRoute, number>> = {
  "llm-context": 60,
  og: 120,
};

export const keyedPerMinute = (route: PublicRoute): number =>
  KEYED_COSTLY[route] ?? KEYED_PER_MINUTE;

export const KEYED_EXCEPTIONS = Object.entries(KEYED_COSTLY)
  .map(([route, capacity]) => `${capacity} on /api/${route}`)
  .join(" and ");

export const KEYED_LIMIT =
  `${KEYED_PER_MINUTE} requests per minute per route (${KEYED_EXCEPTIONS})`;

export const PER_SERVER_NOTE =
  "Each of our servers counts calls on its own, so the limits are " +
  "approximate.";

export const KEYED_CACHE_NOTE =
  "Answers to calls with a key are not kept in our edge cache, so cache " +
  "them on your side.";
