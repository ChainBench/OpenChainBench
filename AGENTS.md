<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes. APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Branch workflow

Two long-lived branches:

- `main` → openchainbench.com (production). Vercel auto-deploy on push is **disabled**; production deploys are **manual** via `vercel --prod` from a checkout of `main`.
- `dev` → staging. Each push triggers `.github/workflows/vercel-staging.yml` which calls Vercel CLI with a token and emits a Preview URL. The Vercel GitHub App is NOT used for staging because the OpenChainBench user account + mobula-labs Vercel team pairing wouldn't propagate.

**Standard flow:**

1. Open a feature branch from `dev`: `git checkout dev && git pull && git checkout -b feat/your-thing`
2. PR `feat/your-thing` → `dev` (NOT `main`). After merge, the staging Action posts a Preview URL in the workflow summary.
3. Review on the Preview URL.
4. When the staging state looks ready to ship, open a PR `dev` → `main`. After merge, manually run `vercel --prod` to deploy production (or ask whoever has the Vercel team session).

**Rules:**

- Never push directly to `main` or `dev`. PRs only.
- The staging URL emits `<meta robots=noindex>` and serves `robots.txt: Disallow /` — see `src/app/robots.ts` and `src/app/layout.tsx`. Don't undo without thinking through duplicate-content SEO impact on the prod domain. Vercel Preview SSO is disabled (URL is publicly shareable), so the noindex is the only thing keeping crawlers out.
- Hotfix path: if prod is on fire and waiting through `dev` is unacceptable, open the fix PR directly against `main`, merge, run `vercel --prod`, then immediately fast-forward `dev` from `main` (`git checkout dev && git merge --ff-only main && git push`) so the two branches don't diverge.
- Required GitHub secrets (repo-level, not environment-scoped): `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.
