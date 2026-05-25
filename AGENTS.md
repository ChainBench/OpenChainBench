<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes. APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Branch workflow

Two long-lived branches:

- `main` → openchainbench.com (production)
- `dev` → staging (auto-deployed by Vercel to the `*-git-dev-*.vercel.app` preview URL)

**Standard flow:**

1. Open a feature branch from `dev`: `git checkout dev && git pull && git checkout -b feat/your-thing`
2. PR `feat/your-thing` → `dev`. Vercel posts a per-PR preview URL in the checks. Review there.
3. Merge the PR into `dev`. The staging URL refreshes automatically.
4. When the staging state looks ready to ship, open a PR `dev` → `main`. Merge → openchainbench.com auto-deploys.

**Rules:**

- Never push directly to `main`. PRs only.
- Per-PR preview URLs and the `dev` staging URL emit `<meta robots=noindex>` and serve `robots.txt: Disallow /` — see `src/app/robots.ts` and `src/app/layout.tsx`. Don't undo this without thinking through duplicate-content SEO impact on the prod domain.
- Hotfix path: if prod is on fire and waiting through `dev` is unacceptable, open the fix PR directly against `main`, merge, then immediately fast-forward `dev` from `main` (`git checkout dev && git merge --ff-only main && git push`) so the two branches don't diverge.
