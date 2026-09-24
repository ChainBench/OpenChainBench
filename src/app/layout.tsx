import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteSidebar } from "@/components/site-sidebar";
import { SiteFooter } from "@/components/site-footer";
import { SearchProvider } from "@/components/search/search-provider";
import { SITE } from "@/data/site";
import { safeJsonLd } from "@/lib/jsonld";
import { PERSON_ID, PERSON_JSONLD } from "@/lib/hub-jsonld";
import { PHProvider } from "@/components/posthog-provider";

// Self-hosted rather than next/font/google. The Google loader resolves
// every family over the network at BUILD time, so an unreachable
// fonts.googleapis.com fails the deploy: it did twice in twenty minutes
// on 2026-09-23, on JetBrains Mono and then Inter, from commits that
// touched no font code. These read off disk instead.
//
// Variable faces, latin subset, fetched once from Google's own CDN and
// committed under ./fonts with their OFL licences. One file per family
// covers the whole weight axis, so the weights listed here are no longer
// a subset of what is available - any value in the range works.
const inter = localFont({
  src: "./fonts/Inter-latin.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Arial", "sans-serif"],
});

const interTight = localFont({
  src: "./fonts/InterTight-latin.woff2",
  variable: "--font-inter-tight",
  weight: "100 900",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Arial", "sans-serif"],
});

// preload: false on the serif + mono families: they style prose/labels
// below the fold, and their woff2 preloads competed with LCP-critical
// Inter/Inter Tight for bandwidth on first paint. display: swap still
// applies, so they load lazily without invisible text.
const sourceSerif = localFont({
  src: [
    { path: "./fonts/SourceSerif4-latin.woff2", style: "normal", weight: "200 900" },
    { path: "./fonts/SourceSerif4-Italic-latin.woff2", style: "italic", weight: "200 900" },
  ],
  variable: "--font-source-serif",
  display: "swap",
  preload: false,
  // The CLS fallback defaults to Arial; a serif measured against a sans
  // is the wrong metric to size-adjust from.
  adjustFontFallback: "Times New Roman",
  fallback: ["Iowan Old Style", "Times New Roman", "Georgia", "serif"],
});

const jetbrainsMono = localFont({
  src: "./fonts/JetBrainsMono-latin.woff2",
  variable: "--font-jetbrains-mono",
  weight: "100 800",
  display: "swap",
  preload: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0d" },
  ],
};

// Staging / preview deploys (Vercel `dev` branch, per-PR previews) must
// emit a `<meta name="robots" content="noindex">` header so well-behaved
// crawlers that ignore robots.txt still skip indexing. Pairs with the
// robots.ts Disallow rule for VERCEL_ENV !== 'production'.
const IS_STAGING =
  !!process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: "OpenChainBench. Open benchmarks for crypto infrastructure",
    template: "%s · OpenChainBench",
  },
  description:
    "Live benchmarks for crypto infrastructure: RPC latency, bridge fees, L2 finality and price feed accuracy. Open methodology, updated continuously.",
  robots: IS_STAGING
    ? { index: false, follow: false, googleBot: { index: false, follow: false } }
    : {
        index: true,
        follow: true,
        // Grant full snippet + large image previews so Bing / Google SERP
        // stops truncating our data-rich prose and stops suppressing the
        // og:image. Default meta robots caps snippet ~155 chars + max-
        // image-preview:none (invisible on SERP for AI-scraped queries).
        // Next.js Metadata types: camelCase.
        "max-snippet": -1,
        "max-image-preview": "large",
        "max-video-preview": -1,
      } as Metadata["robots"],
  openGraph: {
    title: "OpenChainBench",
    description:
      "Live benchmarks for crypto infrastructure: RPC latency, bridge fees, L2 finality and price feed accuracy.",
    type: "website",
    url: SITE.url,
    siteName: "OpenChainBench",
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenChainBench",
    description: "Open benchmarks for crypto infrastructure.",
    site: SITE.twitter,
  },
  // The <link rel="alternate" type="application/rss+xml"> is emitted
  // directly in the <head> JSX (layout render) because Next Metadata
  // .alternates.types silently drops the entry in App Router.
  alternates: {
    canonical: SITE.url,
  },
};

const ORG_JSONLD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE.url}/#org`,
      name: SITE.name,
      alternateName: ["OCB", "Open Chain Bench"],
      url: SITE.url,
      // Logo must be an ImageObject with explicit width and height to be
      // eligible for the Google Logo / Knowledge Panel rich result. A
      // bare URL string is accepted by schema.org but ignored by Google.
      // The same node is referenced as `publisher.logo` by every
      // TechArticle / Dataset on the site, so this single fix unblocks
      // Article rich results sitewide.
      logo: {
        "@type": "ImageObject",
        url: `${SITE.url}/logo.png`,
        width: 512,
        height: 512,
      },
      description: SITE.description,
      foundingDate: "2026-04-28",
      email: SITE.email,
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "editorial",
        email: SITE.email,
        availableLanguage: ["English"],
      },
      // Named founder, anchored to the canonical Person node emitted below
      // in the same @graph. Lets Search Console + AI answer surfaces
      // attribute the project to a real human, which is the missing
      // E-E-A-T signal on data-driven editorial pages.
      founder: { "@id": PERSON_ID },
      sameAs: [
        SITE.github,
        `https://x.com/${SITE.twitter.replace(/^@/, "")}`,
        // Wikidata entity: anchors the OpenChainBench brand in the
        // Knowledge Graph so the brand query resolves to this domain
        // instead of the unrelated "OpenBench" homonyms.
        "https://www.wikidata.org/wiki/Q140756438",
      ],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE.url}/#site`,
      url: SITE.url,
      name: SITE.name,
      description: SITE.description,
      publisher: { "@id": `${SITE.url}/#org` },
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${SITE.url}/benchmarks?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    },
    // Canonical Person node for the sole named maintainer. Referenced by
    // Organization.founder above, by every bench's StatisticalReport
    // (contributor) and by bench TechArticles (author + reviewedBy).
    // Anchoring here in the site-wide @graph means every per-page node
    // that references PERSON_ID resolves against a single authoritative
    // definition instead of duplicating the Person shape across pages.
    PERSON_JSONLD,
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The search corpus is no longer built here: it had grown to ~880
  // docs / 278 KB and was serialized into every page. The client fetches
  // /api/search/index on first intent instead.
  return (
    <html
      lang="en"
      className={`${inter.variable} ${interTight.variable} ${sourceSerif.variable} ${jetbrainsMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        {/* RSS feed auto-discovery. Next Metadata.alternates.types does
            NOT render this in App Router (silently dropped); emit directly
            in <head> so feed readers, AI crawlers (Perplexity, Bing News,
            Claude), and browsers pick up /rss.xml. */}
        <link
          rel="alternate"
          type="application/rss+xml"
          title="OpenChainBench: new benchmarks"
          href="/rss.xml"
        />
        {/* JSON Feed 1.1 companion. Modern feed readers + AI agent
            tooling (Perplexity, LangChain document loaders, MCP
            clients) parse JSON without an XML dependency. */}
        <link
          rel="alternate"
          type="application/feed+json"
          title="OpenChainBench: new benchmarks (JSON Feed)"
          href="/feed.json"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('ocb-theme');var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');}catch(e){}})();`,
          }}
        />
        {/* Detect iOS in-app WebView (Telegram, Instagram, FB, Twitter, etc.).
            These hosts hit the iOS 26 WebKit fixed/sticky jitter bug
            (bugs.webkit.org/297779) harder than regular Safari because their
            own URL-bar overlay animates the layout viewport on top of the
            WebKit regression. CSS below downgrades the site header to
            non-sticky only when this class is present. Inline so the class
            is on the html element before React hydrates (no flash). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var ua=navigator.userAgent;if(/iPhone|iPad|iPod/.test(ua)&&!/Safari\\//.test(ua))document.documentElement.classList.add('ios-webview');}catch(e){}})();`,
          }}
        />
        {/* Site-wide Organization + WebSite JSON-LD. Lives inside <head>
            (not body) so stricter parsers (some AI search crawlers, schema
            validators) that only scan <head> for structured data pick it
            up. Google parses both head and body, so this is a pure
            placement change with no schema-content delta. */}
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(ORG_JSONLD) }}
        />
        {/* Ahrefs Web Analytics. Privacy-friendly (no cookies, no PII),
            loaded async so it never blocks paint. Key is exposed at
            NEXT_PUBLIC_AHREFS_KEY so it ships with the static bundle
            (the key is public by design — it identifies the property,
            not an account secret). Skipped entirely when env unset so
            staging/preview deploys do not pollute the analytics graph. */}
        {process.env.NEXT_PUBLIC_AHREFS_KEY && (
          <script
            src="https://analytics.ahrefs.com/analytics.js"
            data-key={process.env.NEXT_PUBLIC_AHREFS_KEY}
            async
          />
        )}
      </head>
      {/* grid (not flex) so position: sticky on <SiteHeader> works reliably
          on iOS Safari — sticky inside a flex column has known quirks.
          Do NOT add overflow-x clip here — WebKit treats it as creating a
          containing block for position: fixed descendants and the header
          ends up scrolling with the body. Clip is on html + main + article. */}
      {/* grid-cols-[minmax(0,1fr)]: the implicit `auto` column sized the page to
          the header's min-content (the search trigger's 0% basis resolves to its
          text width inside intrinsic sizing), so every page was 1,207 px wide on a
          1,024 px viewport and scrolled sideways. minmax(0,1fr) lets rows be
          narrower than their min-content. */}
      <body className="min-h-full grid grid-rows-[auto_1fr_auto] grid-cols-[minmax(0,1fr)] lg:pl-[var(--sidebar-w)]">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <PHProvider>
          <SearchProvider>
            {/* Fixed, so it sits outside the grid rows entirely and
                leaves the sticky-header and column-sizing behaviour
                above untouched. The offset that makes room for it is a
                padding on <body>, not a wrapper: a wrapper would collapse
                the three grid rows into one item at lg and the 1fr that
                stretches <main> would stop applying, dropping the footer
                up the page on short routes. */}
            <SiteSidebar />
            <SiteHeader />
            <main id="main-content" className="flex-1 w-full max-w-full overflow-x-clip min-w-0">{children}</main>
            <SiteFooter />
          </SearchProvider>
          {process.env.VERCEL_ENV === "production" && <Analytics />}
        </PHProvider>
      </body>
    </html>
  );
}
