import { Octokit } from "@octokit/rest";

const GH_TOKEN = process.env.GITHUB_TOKEN;
if (!GH_TOKEN && process.env.NODE_ENV === "production") {
  console.warn("GITHUB_TOKEN missing — read paths will rate-limit fast");
}

export const gh = new Octokit({ auth: GH_TOKEN, userAgent: "openbench-monitoring/0.1" });

export type FileState =
  | { exists: true; sha: string; size: number; updatedAt?: string }
  | { exists: false };

export async function fileState(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<FileState> {
  try {
    const res = await gh.repos.getContent({ owner, repo, path, ref });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file") return { exists: false };
    return { exists: true, sha: data.sha, size: data.size };
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 404) return { exists: false };
    throw err;
  }
}

export async function fileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const res = await gh.repos.getContent({ owner, repo, path, ref });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 404) return null;
    throw err;
  }
}

export async function lastCommitForPath(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<{ sha: string; message: string; date: string; author: string } | null> {
  try {
    const res = await gh.repos.listCommits({ owner, repo, path, sha: ref, per_page: 1 });
    const c = res.data[0];
    if (!c) return null;
    return {
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      date: c.commit.author?.date ?? "",
      author: c.commit.author?.name ?? "unknown",
    };
  } catch {
    return null;
  }
}
