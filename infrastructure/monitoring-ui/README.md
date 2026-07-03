# OpenBench monitoring UI

Internal control plane for OpenChainBench. Railway deploys it straight from this repo (root directory `infrastructure/monitoring-ui`).

Shows every bench's state on `main` (prod) and `dev` (staging) side by side. Highlights drift, staging-only, prod-only, and missing benches. Pulls live data from GitHub via the contents API. Action buttons promote / demote via auto-merged PRs + Vercel deploy.

## Railway setup

1. New service on the existing Railway project.
2. Source: `ChainBench/OpenChainBench`, branch `dev`.
3. **Root Directory**: `infrastructure/monitoring-ui`.
4. Builder: Dockerfile (auto-detected).
5. Env vars: see table below.
6. Generate a public domain.

## Roadmap

- V0 — read-only dashboard *(current)*
- V1 — `Promote → main` and `Remove from main` buttons (PR auto-merge + `vercel --prod`)
- V2 — multi-file promotion (YAML + suggested shared deps)
- V3 — harness ops: redeploy binary on OVH, restart Railway service, tail logs via `/logs?tail=N`
- V4 — audit log + per-bench history view

## Stack

- Next.js 15 App Router · TypeScript · Tailwind
- `@octokit/rest` for GitHub state
- Basic-auth middleware gated on `ADMIN_BASIC_AUTH`
- Deploy: Railway via the included `Dockerfile`

## Env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `GITHUB_TOKEN` | yes (prod) | fine-grained PAT, `Contents: read` on OCB + mobula-monorepo |
| `ADMIN_BASIC_AUTH` | yes (prod) | `username:password` for the basic-auth gate |
| `VERCEL_TOKEN` | V1 | trigger `vercel --prod` after promotion merges |
| `LOGS_TOKEN` | V3 | shared bearer for harness `/logs` endpoints |
| `OVH_CADDY_AUTH` | V3 | `user:pass` for the OVH Caddy basic-auth (HL bench) |

## Dev

```bash
bun install
bun run dev
```

## Deploy

Push to `dev` on `ChainBench/OpenChainBench`. Railway auto-builds the Dockerfile in this subdir.

## Registry

`src/lib/registry.ts` maps each bench slug to its YAML path + harness runtime. Update this when a new bench ships.
