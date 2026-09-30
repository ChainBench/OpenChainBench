import {
  ArrowLeftRight,
  BookOpen,
  Boxes,
  ChartColumn,
  CircleHelp,
  Code,
  Database,
  FileText,
  GitCompare,
  GitPullRequest,
  Gauge,
  House,
  Info,
  Landmark,
  Layers,
  MapPin,
  PiggyBank,
  Scale,
  Server,
  Smartphone,
  Target,
  TrendingUp,
  Zap,
} from "lucide-react";
/**
 * The gate is a PARAMETER here, not a module-level read of the
 * environment, because this file is reached from client components.
 *
 * isDevOnlyRoute() closes over `process.env.VERCEL_ENV`, which Next only
 * inlines into a client bundle for NEXT_PUBLIC_-prefixed variables. In the
 * browser it is undefined, so the flag was false, so the guard passed and
 * the nav rendered links to routes production does not serve. The server
 * rendered the correct HTML and hydration put the link back: on
 * 2026-09-30 production shipped no /rpc-map link in its HTML and showed
 * one in the sidebar anyway.
 *
 * The layout is a server component, reads the gate where the environment
 * is real, and passes the result down. Callers that do not know (a test,
 * a story) get the full nav, which is the safe default for a menu.
 */

/**
 * The site's navigation, in one place, because it was previously in two
 * that disagreed: the header offered six links while the footer listed
 * twenty, so a reader who never scrolled to the footer had no way to
 * discover /perps, /prediction-markets, /rwa, /bridge or /trading-apps.
 *
 * The sidebar renders every group; the header renders only `inHeader`
 * items, which is the old six-link row kept for viewports below lg where
 * there is no sidebar.
 *
 * `match` decides the active state. A section's detail pages share their
 * index's entry (`/benchmarks/perp-fees` lights up Benchmarks), and "/"
 * matches exactly or every route would inherit a Home highlight.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: typeof House;
  match: (p: string) => boolean;
  /** Also shown in the top header row (the pre-sidebar nav). */
  inHeader?: boolean;
  /** Hidden between md and lg so the header row fits a 768 px viewport. */
  mdHidden?: boolean;
};

export type NavGroup = { label?: string; items: NavItem[] };

const section = (href: string) => (p: string) =>
  p === href || p.startsWith(href + "/");

export function navGroups(hiddenRoutes: readonly string[] = []): NavGroup[] {
  const groups: NavGroup[] = [
    {
      items: [
        { href: "/", label: "Home", icon: House, match: (p) => p === "/" },
        {
          href: "/benchmarks",
          label: "Benchmarks",
          icon: ChartColumn,
          match: section("/benchmarks"),
          inHeader: true,
        },
        {
          href: "/products",
          label: "Products",
          icon: Boxes,
          match: section("/products"),
          inHeader: true,
        },
        { href: "/chains", label: "Chains", icon: Layers, match: section("/chains") },
      ],
    },
    {
      label: "Markets",
      items: [
        { href: "/perps", label: "Perpetuals", icon: TrendingUp, match: section("/perps") },
        {
          href: "/prediction-markets",
          label: "Prediction markets",
          icon: Target,
          match: section("/prediction-markets"),
        },
        { href: "/rwa", label: "Tokenized RWA", icon: Landmark, match: section("/rwa") },
        { href: "/bridge", label: "Bridge", icon: ArrowLeftRight, match: section("/bridge") },
        {
          href: "/trading-apps",
          label: "Trading apps",
          icon: Smartphone,
          match: section("/trading-apps"),
        },
        { href: "/hyperliquid", label: "Hyperliquid", icon: Zap, match: section("/hyperliquid") },
        { href: "/capital", label: "Capital", icon: PiggyBank, match: section("/capital") },
      ],
    },
    {
      label: "Infrastructure",
      items: [
        { href: "/rpc", label: "RPC", icon: Server, match: (p) => p === "/rpc" || p.startsWith("/rpc/") },
        ...(hiddenRoutes.includes("/speedtest-rpc")
          ? []
          : [
              {
                href: "/speedtest-rpc",
                label: "RPC speed test",
                icon: Gauge,
                match: section("/speedtest-rpc"),
              },
            ]),
        // The map is what the speed test feeds, and it had no link from
        // anywhere on the site: it reached production in the sitemap and
        // llms.txt with no path a reader could follow, so the only people
        // who could find it were crawlers.
        ...(hiddenRoutes.includes("/rpc-map")
          ? []
          : [
              {
                href: "/rpc-map",
                label: "RPC latency map",
                icon: MapPin,
                match: section("/rpc-map"),
              },
            ]),
        { href: "/data-api", label: "Data APIs", icon: Database, match: section("/data-api") },
      ],
    },
    {
      label: "Explore",
      items: [
        { href: "/compare", label: "Compare", icon: GitCompare, match: section("/compare") },
        { href: "/alternatives", label: "Alternatives", icon: Scale, match: section("/alternatives") },
        {
          href: "/reports",
          label: "Reports",
          icon: FileText,
          match: section("/reports"),
          inHeader: true,
        },
        { href: "/answers", label: "Answers", icon: CircleHelp, match: section("/answers") },
      ],
    },
    {
      label: "Docs",
      items: [
        {
          href: "/methodology",
          label: "Methodology",
          icon: BookOpen,
          match: (p) => p === "/methodology",
          inHeader: true,
        },
        { href: "/mcp", label: "API & MCP", icon: Code, match: section("/mcp") },
        {
          href: "/contribute",
          label: "Contribute",
          icon: GitPullRequest,
          match: (p) => p === "/contribute",
          inHeader: true,
          mdHidden: true,
        },
        {
          href: "/about",
          label: "About",
          icon: Info,
          match: (p) => p === "/about",
          inHeader: true,
          mdHidden: true,
        },
      ],
    },
  ];
  return groups;
}

/** Flattened, in the order the sidebar shows them. */
export function navItems(hiddenRoutes: readonly string[] = []): NavItem[] {
  return navGroups(hiddenRoutes).flatMap((g) => g.items);
}

/** The pre-sidebar header row: the same six links it had before. */
export function headerNavItems(hiddenRoutes: readonly string[] = []): NavItem[] {
  return navItems(hiddenRoutes).filter((i) => i.inHeader);
}
