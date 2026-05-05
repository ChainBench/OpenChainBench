import Link from "next/link";
import Image from "next/image";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/benchmarks", label: "Benchmarks" },
  { href: "/methodology", label: "Methodology" },
  { href: "/contribute", label: "Contribute" },
];

export function SiteHeader() {
  return (
    <header className="border-b border-rule bg-paper/85 backdrop-blur-md sticky top-0 z-40">
      {/* Masthead. logo · nav · live status · github */}
      <div className="mx-auto max-w-7xl px-6 h-14 flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Image
            src="/logo.png"
            alt="OpenChainBench"
            width={28}
            height={28}
            priority
            className="h-7 w-7 object-contain"
          />
          <span className="display text-[1.25rem] text-ink leading-none">
            OpenChainBench
          </span>
        </Link>

        <nav className="hidden md:block ml-auto">
          <ul className="flex items-center gap-5">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="text-sm text-ink-soft hover:text-ink transition-colors"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <a
          href="https://github.com/OpenChainBench/OpenChainBench"
          className="hidden sm:inline text-sm text-ink-muted hover:text-ink transition-colors shrink-0"
          aria-label="View source on GitHub"
        >
          GitHub
        </a>
      </div>
    </header>
  );
}
