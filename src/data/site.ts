export const SITE = {
  name: "OpenChainBench",
  url: "https://openchainbench.xyz",
  twitter: "@openchainbench",
  github: "https://github.com/OpenChainBench/OpenChainBench",
  description:
    "Open, reproducible benchmarks for crypto infrastructure: aggregators, bridges, RPCs, price feeds.",
} as const;

export const CURRENT_ISSUE = "001";

export const ISSUE_DATE_LONG = new Date().toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});
