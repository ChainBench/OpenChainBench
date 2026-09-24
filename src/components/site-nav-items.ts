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
  Scale,
  Server,
  Smartphone,
  Target,
  TrendingUp,
  Zap,
} from "lucide-react";
import { isDevOnlyRoute } from "@/lib/removed-benches";

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

export function navGroups(): NavGroup[] {
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
      ],
    },
    {
      label: "Infrastructure",
      items: [
        { href: "/rpc", label: "RPC", icon: Server, match: (p) => p === "/rpc" || p.startsWith("/rpc/") },
        ...(isDevOnlyRoute("/speedtest-rpc")
          ? []
          : [
              {
                href: "/speedtest-rpc",
                label: "RPC speed test",
                icon: Gauge,
                match: section("/speedtest-rpc"),
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
        { href: "/answers", label: "Answers", icon: CircleHelp, match: section("/answers") },
        {
          href: "/reports",
          label: "Reports",
          icon: FileText,
          match: section("/reports"),
          inHeader: true,
        },
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
export function navItems(): NavItem[] {
  return navGroups().flatMap((g) => g.items);
}

/** The pre-sidebar header row: the same six links it had before. */
export function headerNavItems(): NavItem[] {
  return navItems().filter((i) => i.inHeader);
}
