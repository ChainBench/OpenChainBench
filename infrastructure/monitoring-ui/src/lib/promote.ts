import { gh, fileContent } from "./github";
import { OCB_REPO } from "./registry";

export type PromoteResult = {
  ok: boolean;
  prUrl?: string;
  mergedSha?: string;
  actionsUrl?: string;
  message: string;
};

const PROD_DEPLOY_ACTIONS_URL =
  "https://github.com/ChainBench/OpenChainBench/actions/workflows/prod-deploy.yml";

async function getDefaultBranchSha(branch: "main" | "dev"): Promise<string> {
  const res = await gh.repos.getBranch({ ...OCB_REPO, branch });
  return res.data.commit.sha;
}

async function createBranch(name: string, fromSha: string) {
  await gh.git.createRef({ ...OCB_REPO, ref: `refs/heads/${name}`, sha: fromSha });
}

async function getFileShaOnBranch(path: string, branch: string): Promise<string | null> {
  try {
    const res = await gh.repos.getContent({ ...OCB_REPO, path, ref: branch });
    if (Array.isArray(res.data) || res.data.type !== "file") return null;
    return res.data.sha;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

async function commitFile(opts: {
  branch: string;
  path: string;
  content: string;
  shaToReplace?: string | null;
  message: string;
}) {
  await gh.repos.createOrUpdateFileContents({
    ...OCB_REPO,
    branch: opts.branch,
    path: opts.path,
    message: opts.message,
    content: Buffer.from(opts.content, "utf-8").toString("base64"),
    sha: opts.shaToReplace ?? undefined,
  });
}

async function deleteFile(opts: { branch: string; path: string; sha: string; message: string }) {
  await gh.repos.deleteFile({
    ...OCB_REPO,
    branch: opts.branch,
    path: opts.path,
    message: opts.message,
    sha: opts.sha,
  });
}

async function openPR(opts: { head: string; base: string; title: string; body: string }) {
  const res = await gh.pulls.create({
    ...OCB_REPO,
    head: opts.head,
    base: opts.base,
    title: opts.title,
    body: opts.body,
  });
  return { number: res.data.number, url: res.data.html_url };
}

async function mergePR(number: number): Promise<string> {
  const res = await gh.pulls.merge({ ...OCB_REPO, pull_number: number, merge_method: "squash" });
  return res.data.sha;
}

export async function promoteBenchToMain(slug: string, yamlPath: string): Promise<PromoteResult> {
  const devContent = await fileContent(OCB_REPO.owner, OCB_REPO.repo, yamlPath, "dev");
  if (devContent == null) return { ok: false, message: `not found on dev: ${yamlPath}` };

  const ts = Date.now();
  const branch = `auto/promote-${slug}-${ts}`;
  const mainSha = await getDefaultBranchSha("main");
  await createBranch(branch, mainSha);

  const existingOnMain = await getFileShaOnBranch(yamlPath, "main");
  await commitFile({
    branch,
    path: yamlPath,
    content: devContent,
    shaToReplace: existingOnMain,
    message: `chore(${slug}): promote from dev to main`,
  });

  const pr = await openPR({
    head: branch,
    base: "main",
    title: `promote: ${slug} → main`,
    body: `Auto-promotion from dev to main via openbench-monitoring.\n\nContent copied from dev's \`${yamlPath}\`.`,
  });

  const mergedSha = await mergePR(pr.number);

  return {
    ok: true,
    prUrl: pr.url,
    mergedSha,
    actionsUrl: PROD_DEPLOY_ACTIONS_URL,
    message: `PR #${pr.number} merged into main. CI deploy started — prod will update in ~3-5 min.`,
  };
}

export async function removeBenchFromMain(slug: string, yamlPath: string): Promise<PromoteResult> {
  const existingSha = await getFileShaOnBranch(yamlPath, "main");
  if (existingSha == null) return { ok: false, message: `not on main: ${yamlPath}` };

  const ts = Date.now();
  const branch = `auto/remove-${slug}-${ts}`;
  const mainSha = await getDefaultBranchSha("main");
  await createBranch(branch, mainSha);

  await deleteFile({
    branch,
    path: yamlPath,
    sha: existingSha,
    message: `chore(${slug}): remove from main (keep on dev)`,
  });

  const pr = await openPR({
    head: branch,
    base: "main",
    title: `rollback: ${slug} → staging only`,
    body: `Auto-rollback from main via openbench-monitoring. YAML remains on dev.`,
  });

  const mergedSha = await mergePR(pr.number);

  return {
    ok: true,
    prUrl: pr.url,
    mergedSha,
    actionsUrl: PROD_DEPLOY_ACTIONS_URL,
    message: `PR #${pr.number} merged into main. CI deploy started — prod will update in ~3-5 min.`,
  };
}
