"use client";

import { useState, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

const emptySubscribe = () => () => {};

export function ThemeToggle() {
  // false during SSR + hydration, true once the client can read the DOM.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const domDark = useSyncExternalStore(
    emptySubscribe,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
  const [override, setOverride] = useState<boolean | null>(null);
  const isDark = override ?? domDark;

  function toggle() {
    const next = !isDark;
    setOverride(next);
    const root = document.documentElement;
    if (next) {
      root.classList.add("dark");
      try {
        localStorage.setItem("ocb-theme", "dark");
      } catch {}
    } else {
      root.classList.remove("dark");
      try {
        localStorage.setItem("ocb-theme", "light");
      } catch {}
    }
  }

  if (!mounted) {
    return (
      <span
        aria-hidden
        className="inline-flex items-center justify-center w-8 h-8 rounded-md"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="inline-flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-md hover:bg-paper-soft text-ink-muted hover:text-ink transition-colors"
    >
      {isDark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
