import type { Metadata, Viewport } from "next";
import { Inter, Inter_Tight, JetBrains_Mono, Source_Serif_4 } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { SITE } from "@/data/site";
import { safeJsonLd } from "@/lib/jsonld";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  display: "swap",
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["italic", "normal"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
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
  metadataBase: new URL("https://openchainbench.com"),
  title: {
    default: "OpenChainBench. Open benchmarks for crypto infrastructure",
    template: "%s · OpenChainBench",
  },
  description:
    "Live benchmarks for crypto infrastructure: RPC latency, bridge fees, L2 finality and price feed accuracy. Open methodology, updated continuously.",
  ...(IS_STAGING && {
    robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
  }),
  openGraph: {
    title: "OpenChainBench",
    description:
      "Live benchmarks for crypto infrastructure: RPC latency, bridge fees, L2 finality and price feed accuracy.",
    type: "website",
    url: "https://openchainbench.com",
    siteName: "OpenChainBench",
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenChainBench",
    description: "Open benchmarks for crypto infrastructure.",
    site: SITE.twitter,
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
      parentOrganization: {
        "@type": "Organization",
        name: "Mobula",
        url: "https://mobula.io",
      },
      sameAs: [
        SITE.github,
        `https://x.com/${SITE.twitter.replace(/^@/, "")}`,
        // Wikidata entity: anchors the OpenChainBench brand in the
        // Knowledge Graph so the brand query resolves to this domain
        // instead of the unrelated "OpenBench" homonyms.
        "https://www.wikidata.org/wiki/Q140172649",
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
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${interTight.variable} ${sourceSerif.variable} ${jetbrainsMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
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
      </head>
      {/* grid (not flex) so position: sticky on <SiteHeader> works reliably
          on iOS Safari — sticky inside a flex column has known quirks.
          Do NOT add overflow-x clip here — WebKit treats it as creating a
          containing block for position: fixed descendants and the header
          ends up scrolling with the body. Clip is on html + main + article. */}
      <body className="min-h-full grid grid-rows-[auto_1fr_auto]">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <SiteHeader />
        <main id="main-content" className="flex-1 w-full max-w-full overflow-x-clip min-w-0">{children}</main>
        <SiteFooter />
        {process.env.VERCEL_ENV === "production" && <Analytics />}
      </body>
    </html>
  );
}
