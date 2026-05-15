import type { NextConfig } from "next";

// Content-Security-Policy. `'unsafe-inline'` for scripts is needed because
// three pages emit JSON-LD via `dangerouslySetInnerHTML` (layout.tsx,
// providers/[slug]/page.tsx, benchmarks/[slug]/page.tsx). The blocks are
// JSON.stringify of editor-controlled data, no user input, so the residual
// XSS risk is bounded. Future hardening: move JSON-LD to <Script> with a
// sha256 hash in script-src.
const RELAY_WS = "wss://ocb-stream-relay-production.up.railway.app";
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
  `connect-src 'self' ${RELAY_WS}`,
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
  turbopack: {
    root: __dirname,
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
    return [
      // /live now lives at /networks (ecosystem dashboard).
      { source: "/live", destination: "/networks", permanent: true },
    ];
  },
};

export default nextConfig;
