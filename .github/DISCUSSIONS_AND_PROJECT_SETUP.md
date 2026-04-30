# Discussions & Project board — manual setup

This file documents the GitHub UI configuration that lives outside the repo (Discussions categories, the Project board). It exists so a maintainer can recreate the setup if it gets lost or migrated.

## Discussions

**Setup path:** Repo → Discussions tab → ⚙️ "Manage categories"

| Category | Type | Description |
| --- | --- | --- |
| 📣 Announcements | Announcement (maintainers only) | New benchmarks shipped, methodology changes, infrastructure migrations. |
| 💡 Ideas | Open-ended discussion | Brainstorm new benchmarks, providers, or methodology improvements before writing them up. |
| 🙋 Q&A | Question / Answer | Ask how a spec / harness / metric works. Pick a best answer when one is given. |
| 📊 Show & tell | Open-ended discussion | Share a fork, a derived dashboard, a benchmark you ran locally. |

Default categories like "General" and "Polls" should be deleted to keep the surface focused.

## Roadmap Project

**Setup path:** Org → Projects tab → New project → "From scratch" → Board template

- **Name**: `OpenChainBench Roadmap`
- **Visibility**: Public
- **Linked repository**: `OpenChainBench/OpenChainBench`

### Columns

```
Requested  →  Approved  →  In progress  →  Live  →  Archived
```

| Column | Meaning |
| --- | --- |
| Requested | A bench has been proposed (issue with `bench-request` label or a Discussion thread). Methodology not yet validated by maintainers. |
| Approved | Methodology agreed on. Spec / harness work can start. |
| In progress | A PR is open implementing the benchmark. |
| Live | Merged + harness wired into Railway + emitting data. |
| Archived | Deprecated, retired, or rejected with a dated note. |

### Workflows

In Project Settings → Workflows, enable:

- **Auto-add to project** — for issues in `OpenChainBench/OpenChainBench` matching the filter `is:issue label:bench-request`. They land in `Requested` automatically.
- **Item closed → Archived** — when an issue is closed without a `live` label, move it to `Archived`.
- **PR merged → Live** (manual; GitHub doesn't have a native trigger, so a maintainer moves the card after merge).

### Custom fields (optional)

- `Category` (single-select): RPC / Aggregator / Bridge / Price feed / Wallet / Other.
- `Priority` (single-select): P0 / P1 / P2.
- `Owner` (text or person reference).

## Labels

These labels back the issue templates and the project workflow. Create them under Repo → Issues → Labels:

| Label | Color | Description |
| --- | --- | --- |
| `bench-request` | `#0e8a16` (green) | Used by `new-benchmark.yml` template; auto-adds to the Project board. |
| `data-quality` | `#fbca04` (yellow) | Used by `data-quality.yml`; site / data anomaly. |
| `correction` | `#d93f0b` (orange) | Provider-submitted correction. |
| `provider` | `#5319e7` (purple) | Combined with `correction` to mark provider-affiliated issues. |
| `live` | `#0366d6` (blue) | Bench is published and emitting data; survives an issue's lifetime. |
| `harness-bug` | `#b60205` (red) | A harness has stopped emitting or is reporting wrong values. |
| `methodology` | `#5319e7` (purple) | Discussion about how a benchmark is computed. |
| `good first issue` | `#7057ff` (purple) | Curated easy-entry tasks for new contributors. |
| `help wanted` | `#008672` (teal) | Maintainers explicitly want outside contribution. |

## Re-running this setup

If the Project or Discussions are wiped:

1. Re-create the Discussions categories per the table above.
2. Re-create the Project with the columns + workflows.
3. Add the labels listed in the Labels section.
4. Push a tiny change to this file documenting the date of the rebuild so the next maintainer knows when the configuration was last verified.
