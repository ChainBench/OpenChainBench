import type { Metadata } from "next";
import { Inter, Inter_Tight, JetBrains_Mono, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

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

export const metadata: Metadata = {
  metadataBase: new URL("https://openchainbench.com"),
  title: {
    default: "OpenChainBench. Open benchmarks for crypto infrastructure",
    template: "%s · OpenChainBench",
  },
  description:
    "Open, reproducible benchmarks for the multichain stack. aggregators, bridges, RPCs, price feeds.",
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${interTight.variable} ${sourceSerif.variable} ${jetbrainsMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
