# open_logo_3d — cleanup audit

Background research pass, 2026-06-05. Top 10 refactors ranked by
(impact for future maintainability × low ship risk).

## Top 10 refactor priorities

### 1. Extract shared formatters to /src/lib/formatters.ts
Files: `BarChartRace.tsx:339`, `Outro.tsx:157`, `CountPodium.tsx:257`, `DistributionRace.tsx:239`, `TimeSeriesRace.tsx:325`.
`formatValue()` is identically duplicated 4×. `formatDate()` twice.
**Fix**: single module with `formatValue(v, unit)`, `formatDate(ts)`, `formatTick(v, unit)`, `formatDateShort(ts)`.
**Saves ~80 LOC**, normalises USD/ms/count precision across all views.

### 2. Move BenchPayload + ProviderSeries to /src/types/bench.ts
Files: `BarChartRace/mock-data.ts:7-18`, imported by every composition + API route.
Types correct but live in a "mock" file. Conceptual friction.
**Fix**: move shape types to `/src/types/bench.ts`; mock fixtures stay in `/src/lib/mock-data.ts` (renamed).
**Unblocks OCB integration** — API consumer doesn't conflate schema with fixtures.

### 3. Extract hardcoded URLs to /src/lib/config.ts
Files: `BarChartRace.tsx:186`, `bench-frame.tsx:123`, `Outro.tsx:151`, `page.tsx:127`.
`openchainbench.com/benchmarks/{slug}` hardcoded 3+ times.
**Fix**: `const BENCH_SITE_URL = process.env.NEXT_PUBLIC_BENCH_SITE_URL ?? "https://openchainbench.com"; export const benchUrl = (slug) => \`${BENCH_SITE_URL}/benchmarks/${slug}\``.
**OCB integration unblocker** — single env var swaps the host.

### 4. Consolidate theme literal unions to a shared constant
Files: `Root.tsx:36/48/60/70`, `Intro.tsx:27`, all compositions.
Some compositions use `z.enum(["light", "dark"])`, Intro uses `z.literal("dark")` deliberately. Inconsistent.
**Fix**: `export const THEME_MODES = ["light", "dark"] as const` in `theme.ts`. Compose schemas with `z.enum(THEME_MODES)`.

### 5. Extract layout constants to /src/lib/layout.ts
Files: `BarChartRace.tsx:225-230`, `TimeSeriesRace.tsx:36-39`, `DistributionRace.tsx:38-39`, `DonutRace.tsx:34-37`, `CountPodium.tsx:33-36`.
Each composition hardcodes `CHART_LEFT=80/160/520`, `ROW_H=78/64`, `TOP_OFFSET=320`. Zero consistency.
**Fix**: `export const LAYOUTS = { barRace: {...}, timeSeries: {...}, ... }` — per-comp overrides, but centralised.

### 6. Standardise prop passing convention
All compositions accept `theme: "light" | "dark"` (string), call `themeFor(theme)` internally once. Drop Theme-object overloads.

### 7. Extract Three.js material + lighting to /src/lib/three-config.ts
File: `Logo3D.tsx:77-80` (lighting), `Logo3D.tsx:113-123` (material).
Calibration values inline. Future 3D assets (outro sphere, backgrounds) would re-invent.

### 8. Split /api/render route into named helpers
File: `app/api/render/route.ts` (~140 LOC).
**Fix**: `validatePayload()`, `renderRaceComposition()`, `renderOutroComposition()`, `concatIntroRaceOutro()`. Route becomes a thin orchestrator. Each step unit-testable.

### 9. Create /src/lib/step-animation.ts for shared step-based motion
Files: every composition redefines `stepFloat()`, stagger logic, entrance/exit fade timings. `FRAMES_PER_STEP=15` hardcoded in 2 places.
**Fix**: export `stepFloat()`, `staggers()`, `enterExitFade()`.

### 10. BenchData adapter layer to hide mock vs real OCB
**Fix**: `interface BenchDataSource { fetch(): Promise<BenchPayload[]> }`. `MockDataSource`, `LiveOCBSource`. Page becomes `const sources = [new LiveOCBSource(), new MockDataSource()]`.

## Do-nothing list

These look like smells but are NOT:

- **Intro hardcoded to `z.literal("dark")`** — intentional, art-direction call.
- **Three.js roughness per-theme** (`Logo3D.tsx:115`) — real calibration shift between light/dark.
- **FLIP animation in BarChartRace** — `prevRankBySlug` map is correctly scoped to that view.
- **Mock data deterministic LCG PRNG** (`mock-data.ts`) — reproducible noise, same seed per provider. Good call.
- **Hardcoded `fps={30}` per Composition** — redundant but explicit, easier to read than a global default.

## OCB integration blockers (must fix before port)

1. Hardcoded SITE URLs (#3)
2. BenchPayload shape coupled to mock-data.ts (#2)
3. Intro + Brand colours assume Mobula ownership — Logo3D sphere texture, BrandText "OpenChainBench", theme colours. OCB will need brand registry lookups.
4. No env-aware asset loading — `staticFile("logo-texture.png")` hardcoded. OCB may serve from CDN/S3.

**Recommendation**: complete #2, #3, #7 before the export-video-modal lands. They're orthogonal to the modal UI but save 2-3 days of integration friction.
