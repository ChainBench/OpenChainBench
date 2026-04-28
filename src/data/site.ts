export const SITE = {
  name: "OpenChainBench",
  url: "https://openchainbench.xyz",
  twitter: "@openchainbench",
  github: "https://github.com/mobula/openchainbench",
  description:
    "Open, reproducible benchmarks for crypto infrastructure: aggregators, bridges, price feeds.",
} as const;

export const CURRENT_ISSUE = "001";

export const ISSUE_DATE_LONG = new Date().toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

export const SPONSOR = {
  name: "Mobula",
  url: "https://mobula.io",
  note: "Mobula sponsors infrastructure costs. Methodology and editorial control sit with the OpenChainBench maintainers; sponsor results are reported the same way as competitors.",
} as const;
