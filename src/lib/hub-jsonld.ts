/**
 * Per-hub-page JSON-LD payloads. Each hub (about, methodology, contribute,
 * press, mcp) gets a BreadcrumbList + a topical type (AboutPage / TechArticle /
 * SoftwareApplication) so Search Console parses them as something more
 * specific than "another WebPage". The root layout already emits Organization
 * + WebSite + SearchAction across every route, so we don't repeat those here.
 */

import { SITE } from "@/data/site";

const ORIGIN = SITE.url;

function breadcrumb(name: string, path: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/` },
      { "@type": "ListItem", position: 2, name, item: `${ORIGIN}${path}` },
    ],
  };
}

export function aboutPageLd() {
  const url = `${ORIGIN}/about`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "AboutPage",
      "@id": `${url}#about`,
      url,
      name: "About OpenChainBench",
      description: "Why OpenChainBench exists and how it stays honest.",
      mainEntity: { "@id": `${ORIGIN}/#org` },
    },
    breadcrumb("About", "/about"),
  ];
}

export function methodologyPageLd() {
  const url = `${ORIGIN}/methodology`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      "@id": `${url}#article`,
      url,
      headline: "OpenChainBench methodology",
      description:
        "How OpenChainBench measures: design principles, statistical conventions, and reproduction guidelines.",
      author: { "@id": `${ORIGIN}/#org` },
      publisher: { "@id": `${ORIGIN}/#org` },
      inLanguage: "en",
      proficiencyLevel: "Expert",
    },
    // HowTo mirrors the "Reproducing a result" recipe in the page body.
    // Google's structured-data parser treats HowTo blocks as candidates
    // for step-by-step rich results and AI assistants (Perplexity, ChatGPT
    // search) lift the step list verbatim when the source page is the
    // authoritative one — which OpenChainBench is for its own method.
    {
      "@context": "https://schema.org",
      "@type": "HowTo",
      "@id": `${url}#reproduce`,
      name: "How OpenChainBench measures blockchain providers",
      description:
        "Reproduce any OpenChainBench number end-to-end: clone the harness, point Prometheus at it, compare the published aggregates after a 24-hour run.",
      step: [
        {
          "@type": "HowToStep",
          position: 1,
          name: "Clone the harness",
          text: "Clone the harness from the link at the bottom of any benchmark report.",
        },
        {
          "@type": "HowToStep",
          position: 2,
          name: "Configure providers",
          text: "Set API keys for the providers you want to include. Public endpoints work for most aggregators; some bridges require allow-listing.",
        },
        {
          "@type": "HowToStep",
          position: 3,
          name: "Run the harness",
          text: "Run the harness. It exposes /metrics over HTTP. Point a local Prometheus at it, or query the public OpenChainBench Prometheus directly.",
        },
        {
          "@type": "HowToStep",
          position: 4,
          name: "Collect a comparable sample",
          text: "Run for at least 24 hours to get a comparable sample size, typically n ≥ 1,000 per provider per region.",
        },
        {
          "@type": "HowToStep",
          position: 5,
          name: "Compare and file corrections",
          text: "Compare your aggregates to the published numbers. If they diverge, file a provider correction with a reproducer.",
        },
      ],
      publisher: { "@id": `${ORIGIN}/#org` },
    },
    breadcrumb("Methodology", "/methodology"),
  ];
}

export function contributePageLd() {
  const url = `${ORIGIN}/contribute`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "HowTo",
      "@id": `${url}#howto`,
      url,
      name: "Contribute a benchmark to OpenChainBench",
      description: "How to publish your own benchmark on OpenChainBench in six steps.",
      step: [
        { "@type": "HowToStep", position: 1, name: "Open an issue", text: "Align on the metric." },
        { "@type": "HowToStep", position: 2, name: "Write the spec", text: "One YAML file." },
        { "@type": "HowToStep", position: 3, name: "Build the harness", text: "Expose /metrics." },
        { "@type": "HowToStep", position: 4, name: "Host it", text: "Anywhere with HTTPS." },
        { "@type": "HowToStep", position: 5, name: "Wire the scrape", text: "One block in prometheus.yml." },
        { "@type": "HowToStep", position: 6, name: "Open a PR", text: "Spec + harness reference, reviewed openly." },
      ],
    },
    breadcrumb("Contribute", "/contribute"),
  ];
}

export function pressPageLd() {
  const url = `${ORIGIN}/press`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "AboutPage",
      "@id": `${url}#press`,
      url,
      name: "OpenChainBench press kit",
      description:
        "Logos, boilerplate and contact details for journalists and partners.",
      mainEntity: { "@id": `${ORIGIN}/#org` },
    },
    breadcrumb("Press kit", "/press"),
  ];
}

export function mcpPageLd() {
  const url = `${ORIGIN}/mcp`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "@id": `${url}#mcp`,
      url,
      name: "OpenChainBench MCP server",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      description:
        "Model Context Protocol server exposing every OpenChainBench benchmark as a typed tool callable from Claude Desktop, Cursor, and any MCP-compatible client.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": `${ORIGIN}/#org` },
    },
    breadcrumb("MCP server", "/mcp"),
  ];
}
