import type { Metadata, Viewport } from "next";
import { Inter, Inter_Tight, JetBrains_Mono, Source_Serif_4 } from "next/font/google";
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
    "Open, reproducible benchmarks for the multichain stack. aggregators, bridges, RPCs, price feeds.",
  ...(IS_STAGING && {
    robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
  }),
  openGraph: {
    title: "OpenChainBench",
    description: "Open, reproducible benchmarks for the multichain stack.",
    type: "website",
    url: "https://openchainbench.com",
    siteName: "OpenChainBench",
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenChainBench",
    description: "Open benchmarks for crypto infrastructure.",
    site: "@openchainbench",
  },
};

const ORG_JSONLD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE.url}/#org`,
      name: SITE.name,
      url: SITE.url,
      logo: `${SITE.url}/logo.png`,
      description: SITE.description,
      sameAs: [
        SITE.github,
        `https://twitter.com/${SITE.twitter.replace(/^@/, "")}`,
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
      </head>
      {/* grid (not flex) so position: sticky on <SiteHeader> works reliably
          on iOS Safari — sticky inside a flex column has known quirks.
          w-full + overflow-x-clip on the body guarantees no descendant can
          push the page past the viewport, even when WKWebView (Telegram in-app
          browser) ignores the html-level safety net in globals.css. */}
      <body className="min-h-full w-full max-w-full overflow-x-clip grid grid-rows-[auto_1fr_auto]">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd(ORG_JSONLD) }}
        />
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <SiteHeader />
        <main id="main-content" className="flex-1 w-full max-w-full overflow-x-clip min-w-0">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
