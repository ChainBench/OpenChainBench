import type { NextConfig } from "next";

// Content-Security-Policy. `'unsafe-inline'` for scripts is needed because
// three pages emit JSON-LD via `dangerouslySetInnerHTML` (layout.tsx,
// providers/[slug]/page.tsx, benchmarks/[slug]/page.tsx). The blocks are
// JSON.stringify of editor-controlled data, no user input, so the residual
// XSS risk is bounded. Future hardening: move JSON-LD to <Script> with a
// sha256 hash in script-src.
const RELAY_WS = "wss://ocb-stream-relay-production.up.railway.app";
// Origin of the standalone Remotion renderer that serves Export Video MP4s
// (cached via sha256 at /v/<hash>.mp4). Allowed in media-src so the
// modal's <video> tag can play the result, and in connect-src so the
// proxy's success URL can be opportunistically pre-fetched.
const VIDEO_RENDERER_ORIGIN = "https://video.openchainbench.com";
const IS_DEV = process.env.NODE_ENV !== "production";
// React dev mode needs 'unsafe-eval' for fast refresh / call stack reconstruction.
// In prod we keep the lock-tight policy.
const SCRIPT_SRC = IS_DEV
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";
const CSP = [
  "default-src 'self'",
  SCRIPT_SRC,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${RELAY_WS} ${VIDEO_RENDERER_ORIGIN}`,
  `media-src 'self' ${VIDEO_RENDERER_ORIGIN}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
];

const nextConfig: NextConfig = {
  // Explicit non-trailing-slash URLs so /benchmarks and /benchmarks/ don't
  // diverge into two indexable variants. Default is `false` already; we
  // pin it so a future Next minor that flips defaults can't silently
  // split bench rankings between the two surface URLs.
  trailingSlash: false,
  // Inject a build-time timestamp so the sitemap can emit a stable
  // <lastmod> per deploy instead of `new Date()` at request time. The
  // sitemap runs on force-dynamic (to bypass Next's 2 MB Data Cache
  // limit), which means `new Date()` at module init evaluates anew on
  // every Google crawl. Result: every URL in the sitemap got a freshly
  // updated lastmod each visit, Google flagged the signal as unreliable
  // and stopped using it to prioritise recrawls. This baking pins the
  // value at build time so it changes only when a new deploy ships.
  env: {
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  turbopack: {
    root: __dirname,
  },
  // Build-time page budget. The Prom client serializes queries through a
  // global concurrency cap (src/lib/prometheus.ts); the FIRST page each
  // build worker prerenders pays the whole multi-bench Prom load and can
  // exceed the default 60 s budget (observed 2026-06-10: staging build
  // failing on /products/<slug> + OG-image routes after the cap landed).
  // Later pages reuse the worker cache and render in milliseconds, so
  // only that first-page budget needs headroom.
  staticPageGenerationTimeout: 240,
  // Tree-shake lucide-react down to just the icons we actually import.
  // Without this hint Next's App Router can include the full barrel
  // (~1k icons, ~25 KB gzipped) on routes that touch lucide indirectly.
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
      {
        // Badges are designed to be embedded as <img> in third-party
        // READMEs and blogs. Override frame-ancestors so SVG embedding
        // via <iframe>/<object> also works. Drop the X-Frame-Options
        // equivalent by allowing all ancestors. CSP still applies
        // (img-src etc.) — only frame embedding is opened.
        source: "/api/badge/:path*",
        headers: [
          ...SECURITY_HEADERS.filter((h) => h.key !== "Content-Security-Policy"),
          {
            key: "Content-Security-Policy",
            value: CSP.replace("frame-ancestors 'none'", "frame-ancestors *"),
          },
        ],
      },
    ];
  },
  async redirects() {
    // Chains live at /chains/<slug> per the new chain hub route family.
    // Many of these slugs also resolve under /products/<slug> because
    // the bench loader treats row shape benches (l1-finality,
    // l2-block-time, network-fees) as if the chains were providers. We
    // 301 the products surface to the chains surface so Google
    // consolidates rank signal on the chains canonical and so any old
    // bench page link that pointed at /products/<chain> lands on the
    // richer chain hub.
    const CHAIN_REDIRECT_SLUGS = [
      "ethereum",
      "solana",
      "bnb",
      "avalanche",
      "sui",
      "ton",
      "stellar",
      "tron",
      "cardano",
      "litecoin",
      "monero",
      "polygon",
      "arbitrum",
      "optimism",
      "base",
      "zksync",
      "linea",
      "scroll",
      "blast",
      "mantle",
      "taiko",
    ];
    const chainRedirects = CHAIN_REDIRECT_SLUGS.map((slug) => ({
      source: `/products/${slug}`,
      destination: `/chains/${slug}`,
      permanent: true,
    }));
    return [
      { source: "/live", destination: "/", permanent: true },
      { source: "/networks", destination: "/", permanent: true },
      { source: "/providers", destination: "/products", permanent: true },
      { source: "/providers/:slug", destination: "/products/:slug", permanent: true },
      {
        source: "/benchmarks/rpc-latency",
        destination: "/benchmarks/rpc-capabilities",
        permanent: true,
      },
      ...chainRedirects,
    ];
  },
};

export default nextConfig;
