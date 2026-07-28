/**
 * Per-hub-page JSON-LD payloads. Each hub (about, methodology, contribute,
 * press, mcp) gets a BreadcrumbList + a topical type (AboutPage / TechArticle /
 * SoftwareApplication) so Search Console parses them as something more
 * specific than "another WebPage". The root layout already emits Organization
 * + WebSite + SearchAction across every route, so we don't repeat those here.
 */

const ORIGIN = "https://openchainbench.com";

/** Canonical @id for the sole named maintainer of the project. Referenced
 *  from the site-wide Organization node (as `founder`), from every bench's
 *  StatisticalReport (as `contributor`), and from bench TechArticles (as
 *  `author` + `reviewedBy`). Anchoring a single Person @id sitewide is
 *  what lets Search Console + AI answer surfaces attribute the numbers
 *  to a named human, which is the missing E-E-A-T signal on data-driven
 *  editorial pages that would otherwise read as machine-authored. */
export const PERSON_ID = `${ORIGIN}/team#florent-tapponnier`;

export const PERSON_JSONLD = {
  "@type": "Person",
  "@id": PERSON_ID,
  name: "Florent Tapponnier",
  givenName: "Florent",
  familyName: "Tapponnier",
  url: `${ORIGIN}/team`,
  mainEntityOfPage: `${ORIGIN}/team`,
  jobTitle: "Maintainer",
  knowsAbout: [
    "crypto infrastructure benchmarking",
    "RPC latency measurement",
    "oracle deviation",
    "L2 finality",
    "bridge fees",
    "statistical methodology",
  ],
  sameAs: [
    "https://github.com/Flotapponnier",
    "https://www.linkedin.com/in/florent-tapponnier-26324a17a/",
  ],
} as const;

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
      name: "OpenChainBench methodology",
      headline: "OpenChainBench methodology",
      description:
        "How OpenChainBench measures: design principles, statistical conventions, and reproduction guidelines.",
      // Article rich results require image + datePublished. Reuse the
      // page's dedicated OG image so schema.org matches the social card.
      // datePublished pinned to the site launch (matches Org.foundingDate)
      // since the methodology has been stable since day one.
      image: `${ORIGIN}/methodology/opengraph-image`,
      datePublished: "2026-04-28",
      author: { "@id": `${ORIGIN}/#org` },
      publisher: { "@id": `${ORIGIN}/#org` },
      inLanguage: "en",
      proficiencyLevel: "Expert",
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

export function teamPageLd() {
  const url = `${ORIGIN}/team`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "ProfilePage",
      "@id": `${url}#profile`,
      url,
      name: "Team",
      description:
        "Who maintains OpenChainBench: spec review, harness design, statistical review and editorial corrections.",
      mainEntity: { "@id": PERSON_ID },
    },
    { "@context": "https://schema.org", ...PERSON_JSONLD },
    breadcrumb("Team", "/team"),
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
