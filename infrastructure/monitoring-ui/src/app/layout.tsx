import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "OpenBench Monitoring",
  description: "Internal control plane for OCB bench promotion + harness ops",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
