import type { Metadata } from "next";
import { NetworksDashboard } from "@/components/networks/dashboard";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Networks",
  description:
    "Live stream of ecosystem data, transaction volumes, and network activity across supported chains.",
};

export default function NetworksPage() {
  return (
    <article className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16">
      <header className="mb-10 sm:mb-12">
        <h1 className="display text-4xl sm:text-5xl text-ink">Network Ecosystem</h1>
        <p className="mt-4 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          Live stream of ecosystem data, transaction volumes, and network activity across
          supported chains.
        </p>
      </header>

      <NetworksDashboard />
    </article>
  );
}
