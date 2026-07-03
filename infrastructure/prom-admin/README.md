# openchainbench-prom-admin

A hardened admin UI to wipe Prometheus time-series data for a specific bench, behind 3 layers of auth.

## What's here

```
infrastructure/prom-admin/
├── app/
│   ├── api/
│   │   ├── chart/       read-only timeseries for the UI chart
│   │   ├── delete/      ★ DESTRUCTIVE — wipes a selector over a range
│   │   ├── labels/      lists dimension values for a metric
│   │   ├── metrics/     intersects Prom names with the allowlist
│   │   ├── preview/     read-only series-count for a planned delete
│   │   └── smart-clean/ disabled by default (env kill-switch)
│   ├── lib/
│   │   ├── audit.ts      stdout JSONL audit log
│   │   ├── prom.ts       fetch wrappers with bearer for admin endpoints
│   │   ├── rate-limit.ts in-memory token bucket
│   │   └── validate.ts   allowlist + label parsing + range guards
│   ├── health/          unauthenticated 200 for Railway healthcheck
│   ├── layout.tsx
│   └── page.tsx         the UI
├── middleware.ts        ★ HTTP Basic Auth on every route except /health
├── Dockerfile
├── railway.toml
└── package.json
```

## Architecture — 3 layers of auth

```
 ┌────────────┐    Layer 1 (external)    Cloudflare Access — email allowlist
 │  Browser   │  ─────────────────────►  Configured in CF Zero Trust UI
 └────────────┘
       │
       ▼
 ┌──────────────────────────┐   Layer 2 (app)   middleware.ts — HTTP Basic Auth
 │ openchainbench-prom-admin│  ──────────────►  ADMIN_USER / ADMIN_PASS env vars
 │ (this miniapp, on Railway)│
 └──────────────────────────┘
       │
       │ X-Admin-Token: $PROM_ADMIN_TOKEN  (server-side fetch, never in browser)
       ▼
 ┌──────────────┐   Layer 3 (network)   Caddy gateway — bearer-token check
 │ prom-gateway │  ───────────────────► routes /api/v1/admin/* + /-/reload +
 │ (Caddy)      │                       /-/quit through the bearer; reads pass
 └──────────────┘                       through unauthenticated
       │
       │ HTTP, Railway internal DNS only
       ▼
 ┌──────────────┐
 │ prometheus   │   binds 0.0.0.0:9090, exposed only over private DNS
 └──────────────┘
```

Each layer protects against a different failure mode:

- **L1 leak** (CF Access misconfig) → app still asks for Basic Auth, attacker doesn't have the password
- **L2 leak** (Basic Auth password exfiltrated) → app sends bearer server-side only, attacker hitting Caddy directly without the bearer gets 403
- **L3 leak** (bearer exfiltrated) → Prom only listens on internal DNS, attacker can't reach it from outside Railway
- **App XSS** → bearer never lands in the browser, only the Basic Auth cookie does. Attacker has app-level access but can't escalate to wipe.

## Built-in safety constraints (besides auth)

- **Metric allowlist** — only `head_lag_*`, `l1_finality_*`, `l2_block_time_*`, `solana_quote_*`, etc. (see `app/lib/validate.ts`). Reject anything else, including `__name__=~".+"` wildcard tricks.
- **Label parser** — `key="value"` pairs parsed strictly; anything that doesn't match the schema is rejected. No raw PromQL interpolation = no selector injection.
- **Range guards** — max 7 days per delete window, max 90 days into the past, end ≤ now.
- **Series cap** — preview every delete before executing; refuse if matches > 5,000 series.
- **Typed-slug confirmation** — UI must echo back `delete-<metric>-<startTs>` before delete fires.
- **Rate limit** — 5 destructive actions / hour / user, 20 reads / minute / user (per-user, in-memory).
- **Audit log** — every preview, delete, denial logged as JSON to stdout. Tagged `[AUDIT]`. Railway captures stdout, push to Datadog later for retention.
- **Smart-clean disabled** — the bulk auto-wipe endpoint is off by default; set `SMART_CLEAN_ENABLED=true` only when explicitly needed.

## Deploy guide (Railway, noob-friendly)

### Prerequisites

- Railway project with the existing `prometheus` service running
- A Caddy gateway service in front of Prom (see `../openchainbench-monitoring/prom-gateway/README.md`)

### Step 1 — generate secrets

On your laptop:

```bash
# Layer 2 Basic Auth password
ADMIN_PASS=$(openssl rand -base64 24)
echo "ADMIN_PASS=$ADMIN_PASS"

# Layer 3 bearer (same value you'll set on the prom-gateway service)
PROM_ADMIN_TOKEN=$(openssl rand -hex 32)
echo "PROM_ADMIN_TOKEN=$PROM_ADMIN_TOKEN"
```

Save both in 1Password (vault `mobula-engineering`, item `OCB Prom admin secrets`).

### Step 2 — set the bearer on the Caddy gateway

Open the `prom-gateway` Railway service → **Variables** tab → add `PROM_ADMIN_TOKEN` with the value from Step 1. Redeploy.

### Step 3 — create the admin UI service on Railway

1. Same Railway project → **+ New → Empty Service**. Rename `openchainbench-prom-admin`.
2. **Settings → Source**: connect the `ChainBench/OpenChainBench` repo, set **Root Directory** to `infrastructure/prom-admin`.
3. **Variables** tab, add:
   - `ADMIN_USER` = `florent` (or whatever)
   - `ADMIN_PASS` = (value from Step 1)
   - `PROM_ADMIN_TOKEN` = (same value as on the gateway service)
   - `PROM_GATEWAY_URL` = public URL of the gateway, e.g. `https://prom-gateway-production-xxxx.up.railway.app`
4. **Settings → Networking → Generate Domain**. Note the URL.
5. Wait for the build to finish, then open the URL — you should get a Basic Auth prompt. Enter `ADMIN_USER` / `ADMIN_PASS`. UI loads.

### Step 4 — Cloudflare Access (Layer 1)

Optional but recommended.

1. Add your Railway domain to Cloudflare DNS (Cloudflare proxy ON).
2. Cloudflare → **Zero Trust → Access → Applications → Add an application**.
   - Type: **Self-hosted**
   - Subdomain: the one Railway gave you (or your custom one)
3. **Access policies** → Add a rule "team allowlist":
   - Action: **Allow**
   - Include: **Emails** → list your team emails (e.g. `contact@mobula.io`, `florent@mobula.io`)
4. **Authentication** → enable **Google** or **GitHub** as the identity provider (one-click in CF UI; both free).
5. Save. The Railway URL now redirects to a CF login page; only allowlisted emails get through. After CF auth, the Basic Auth prompt fires too.

### Step 5 — smoke test

```bash
# Unauthenticated → 401
curl -i https://openchainbench-prom-admin-production-xxxx.up.railway.app/api/metrics

# Authenticated, valid → 200, list of allowed metrics
curl -u "$ADMIN_USER:$ADMIN_PASS" \
  https://openchainbench-prom-admin-production-xxxx.up.railway.app/api/metrics

# Try to delete with no confirm token → 400 confirm_mismatch
curl -u "$ADMIN_USER:$ADMIN_PASS" -X POST \
  -H 'content-type: application/json' \
  -d '{"metric":"head_lag_seconds","startTime":"2026-06-01T10:00","endTime":"2026-06-01T10:30","confirm":"wrong"}' \
  https://openchainbench-prom-admin-production-xxxx.up.railway.app/api/delete
```

### Step 6 — use the UI

Open the URL in your browser. CF Access prompts for login (if Layer 1 enabled). Basic Auth prompts (Layer 2). UI loads:

1. Pick a metric from the dropdown
2. Optionally enter `labels` (e.g. `chain="solana"`)
3. Pick start + end datetime
4. Click **Preview** → shows how many series will be wiped
5. Click **Delete…** → modal asks for the confirmation token, copy-paste from the highlighted code, click **Confirm delete**
6. UI shows `deleted` with a request_id; audit log entry is in Railway logs as `[AUDIT] {...}`

## Local development

```bash
cp .env.example .env.local
# fill in the values
npm install
npm run dev
# UI at http://localhost:3000
```

The Caddy gateway must be reachable from your laptop for the delete/preview to work end-to-end. For local-only testing, you can point `PROM_GATEWAY_URL` at a Caddy instance running on `localhost:8080`.

## Operational notes

- **Audit log queries**: in Datadog, filter `service:openchainbench-prom-admin @message:"[AUDIT]"` to see every action.
- **Rotating secrets**: change `ADMIN_PASS` and `PROM_ADMIN_TOKEN` on both services (gateway + admin-ui) on the same day. UI sessions invalidate next refresh; gateway picks up the new token on redeploy.
- **Allowlist edits**: append to `ALLOWED_METRIC_PREFIXES` in `app/lib/validate.ts`, commit, redeploy. Do NOT make the allowlist env-driven — keeping it in code means a malicious env var injection can't widen the blast radius.
