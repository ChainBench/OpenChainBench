"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

const STORAGE_KEY = "ocb-banner-dismissed-v1";

/**
 * Top sticky notification banner. Persists dismissal in localStorage so it
 * doesn't reappear on every navigation.
 */
export function SiteBanner() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setHidden(true);
    } catch {
      // ignore
    }
  }, []);

  if (hidden) return null;

  return (
    <div className="bg-banner py-2.5 px-4 relative flex items-center justify-center text-[11px] sm:text-[13px] text-banner-ink text-center pr-10">
      <span>
        The first decentralized benchmark network for crypto infrastructure is live.{" "}
        <br className="sm:hidden" />
        <Link
          href="/benchmarks"
          className="text-banner-link hover:underline underline-offset-2"
        >
          Read the announcement.
        </Link>
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          try {
            window.localStorage.setItem(STORAGE_KEY, "1");
          } catch {
            // ignore
          }
          setHidden(true);
        }}
        className="absolute right-4 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink transition-colors"
      >
        <X className="w-4 h-4" strokeWidth={1.5} />
      </button>
    </div>
  );
}
