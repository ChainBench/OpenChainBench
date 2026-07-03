import { REGISTRY, OCB_REPO, MOBULA_REPO, type BenchEntry } from "./registry";
import { fileState, lastCommitForPath, gh, type FileState } from "./github";

export type BranchSlot = {
  state: FileState;
  lastCommit: { sha: string; message: string; date: string; author: string } | null;
};

export type BenchStatus =
  | "dev_only"
  | "prod_only"
  | "synced"
  | "drift"
  | "missing_everywhere";

export type BenchRow = {
  entry: BenchEntry;
  main: BranchSlot;
  dev: BranchSlot;
  status: BenchStatus;
};

function classify(main: FileState, dev: FileState): BenchStatus {
  if (!main.exists && !dev.exists) return "missing_everywhere";
  if (main.exists && !dev.exists) return "prod_only";
  if (!main.exists && dev.exists) return "dev_only";
  if (main.exists && dev.exists) {
    return main.sha === dev.sha ? "synced" : "drift";
  }
  return "missing_everywhere";
}

async function rowForBench(entry: BenchEntry): Promise<BenchRow> {
  const [mainState, devState, mainCommit, devCommit] = await Promise.all([
    fileState(OCB_REPO.owner, OCB_REPO.repo, entry.ocbYaml, "main"),
    fileState(OCB_REPO.owner, OCB_REPO.repo, entry.ocbYaml, "dev"),
    lastCommitForPath(OCB_REPO.owner, OCB_REPO.repo, entry.ocbYaml, "main"),
    lastCommitForPath(OCB_REPO.owner, OCB_REPO.repo, entry.ocbYaml, "dev"),
  ]);
  return {
    entry,
    main: { state: mainState, lastCommit: mainCommit },
    dev: { state: devState, lastCommit: devCommit },
    status: classify(mainState, devState),
  };
}

async function listBenchSlugsFromBranch(branch: "main" | "dev"): Promise<string[]> {
  try {
    const res = await gh.repos.getContent({
      ...OCB_REPO,
      path: "benchmarks",
      ref: branch,
    });
    if (!Array.isArray(res.data)) return [];
    return res.data
      .filter((f) => f.type === "file" && f.name.endsWith(".yml"))
      .map((f) => f.name.replace(/\.yml$/, ""));
  } catch {
    return [];
  }
}

function entryForSlug(slug: string): BenchEntry {
  const known = REGISTRY.find((e) => e.slug === slug);
  if (known) return known;
  // Auto-discovered bench: minimal placeholder entry.
  return {
    slug,
    name: slug,
    ocbYaml: `benchmarks/${slug}.yml`,
    harness: { type: "none" },
    sourceUrl: `https://github.com/${OCB_REPO.owner}/${OCB_REPO.repo}/blob/dev/benchmarks/${slug}.yml`,
  };
}

export async function loadAllBenchRows(): Promise<BenchRow[]> {
  // Union of slugs found on main + dev, so any bench that lands on either
  // branch shows up in the dashboard without a registry edit. Known benches
  // still pick up their harness/sourceUrl config from REGISTRY.
  const [mainSlugs, devSlugs] = await Promise.all([
    listBenchSlugsFromBranch("main"),
    listBenchSlugsFromBranch("dev"),
  ]);
  const slugSet = new Set<string>([
    ...mainSlugs,
    ...devSlugs,
    ...REGISTRY.map((e) => e.slug),
  ]);
  const entries = Array.from(slugSet)
    .sort()
    .map(entryForSlug);
  const rows = await Promise.all(entries.map(rowForBench));
  return rows;
}

// Re-export to keep the import surface stable.
export { MOBULA_REPO };
