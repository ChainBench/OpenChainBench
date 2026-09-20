import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OCB CRM",
  description: "OpenChainBench internal dashboard",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
