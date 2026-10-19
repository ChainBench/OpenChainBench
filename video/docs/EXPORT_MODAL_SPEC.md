# ExportVideoModal — design spec

Produced by the parallel research pass, 2026-06-05. The implementer should
follow this verbatim unless they discover a reason in the code to deviate
(and document the deviation in a follow-up).

## State shape

```ts
interface ExportConfig {
  range: "24h" | "7d" | "30d";
  view: ViewId;
  selectedProviderSlugs: Set<string>; // selected, not excluded
}

type ViewId =
  | "BarChartRace"
  | "TimeSeriesRace"
  | "DistributionRace"
  | "DonutRace"
  | "CountPodium";

interface ExportVideoModalProps {
  bench: BenchPayload;
  open: boolean;
  onClose: () => void;
  defaultView?: ViewId;
  onRendered?: (mp4Url: string) => void;
}

type RenderState =
  | { status: "idle" }
  | { status: "rendering"; progress: number; startedAt: number }
  | { status: "done"; url: string }
  | { status: "error"; message: string };
```

**Selected, not excluded.** Three reasons:
1. "all selected by default" is one line: `new Set(bench.providers.map(p => p.slug))`
2. URL serialisation is finite + stable (`?providers=a,b,c` instead of "everything minus X")
3. When a new provider appears in the bench mid-session, "excluded" silently opts them in — usually wrong for a share card.

## State management

**`useReducer`, not Zustand, not plain `useState`.**
- 4 fields, ~6 action types (`SET_RANGE`, `TOGGLE_PROVIDER`, `SET_VIEW`, `SELECT_ALL`, `CLEAR_ALL`, `RESET`). Reducer is ~30 lines.
- Zero external deps — clean port to OCB.
- Reducer is the contract: anyone reading the file knows every legal state transition. Zustand hides this in scattered setters.
- Render state lives in a *separate* reducer (or `useState`) — render lifecycle is orthogonal to config.

## Component tree

```
<ExportVideoModal bench open onClose>          // owns useReducer<ExportConfig>
├── <ModalShell>                               // a11y wrapper, focus trap, Esc
│   ├── <ConfigPanel>                          // left column
│   │   ├── <RangePicker value onChange/>
│   │   ├── <ViewPicker value onChange options={compatibleViews}/>
│   │   └── <ProviderMulti
│   │         providers={bench.providers}
│   │         selected onToggle onSelectAll onClear/>
│   ├── <PreviewPlayer                         // right column
│   │     filteredBench={derived}              // memoised
│   │     view={config.view}/>
│   └── <RenderActions
│         config renderState onRender onDownload onShareX/>
└── (Portal root)
```

Six files. No HOCs, no context — `dispatch` is prop-drilled exactly one
level. Drilling is fine at depth 1.

## Filter function

Pure, memoised, ~40 LOC:

```ts
function deriveFilteredBench(
  bench: BenchPayload,
  range: "24h" | "7d" | "30d",
  selectedProviderSlugs: Set<string>,
): FilteredBench;
```

Wire with `useMemo(() => deriveFilteredBench(...), [bench, range, selected])`.

**Edge case**: if `selectedProviderSlugs.size === 0`, return a sentinel
`{ empty: true }` instead of an empty array — the Player renders a
"Select at least one provider" state, doesn't crash on `Math.max(...[])`.

## View ↔ data compatibility

**Disable in dropdown + tooltip explaining why. No auto-redirect.**

Auto-redirect is user-hostile — they pick "Donut", suddenly looking at
"Bar" with no signal. Empty states inside the preview are worse — the
preview is the validator, not the error surface.

| View | Requires |
|---|---|
| `BarChartRace` | always |
| `TimeSeriesRace` | ≥10 timestamps |
| `DistributionRace` | ≥3 providers |
| `DonutRace` | higher-is-better metric |
| `CountPodium` | higher-is-better + ≥3 providers |

Default `view` on open = first compatible view in priority order:
`Bar > TimeSeries > Donut > Distribution > Podium`.

## Render progress UX

**Polling, not SSE.** SSE on Next is fiddly; the render is one bounded
job, no event stream — just "% complete".

API: `POST /api/render-video` returns `{ jobId }`, then
`GET /api/render-video/:jobId` returns `{ status, progress, url? }`.
Poll every 1 s with exponential backoff to 3 s after 30 s elapsed.

UI: indeterminate shimmer 0-5 %, then a determinate bar.
Copy: "Rendering frame 412 / 660". Cancel calls
`DELETE /api/render-video/:jobId`. On done, swap the whole
`<RenderActions>` body for `[Download MP4] [Share on X]`.

Don't show ETA — Remotion render times are bursty and a wrong ETA is
worse than none.

## File structure

```
src/components/export-video/
  ExportVideoModal.tsx       // root + useReducer
  ConfigPanel/
    RangePicker.tsx
    ViewPicker.tsx
    ProviderMulti.tsx
  PreviewPlayer.tsx
  RenderActions.tsx
  lib/
    reducer.ts               // ExportConfig reducer + actions
    deriveFilteredBench.ts   // pure filter
    compatibility.ts         // isViewCompatible + view priority
    useRenderJob.ts          // polling hook
  types.ts
  index.ts                   // re-exports ExportVideoModal only
```

`lib/` separation matters for porting — those four files have **zero
React imports** and move to OCB as-is. The React shell can be rewritten
to OCB's Dialog primitive without touching business logic.

`index.ts` exposes one symbol. Consumers cannot reach into internals.

## Port path to OCB

`ExportVideoModal` accepts `open` + `onClose` props, does NOT own its
trigger button. OCB wraps it with their Radix/shadcn `<Dialog>`. The
`<ModalShell>` becomes a no-op fragment in OCB (or stays for standalone
panel use, swapped via a `shell?: ComponentType` prop).

## Accessibility (non-negotiable)

- `role="dialog"` `aria-modal="true"` `aria-labelledby` on shell
- Focus trap inside modal; restore focus to trigger on close
- Esc closes only when render is `idle` or `done` — block during
  `rendering` (show confirm)
- Every checkbox: `<label>` wrapping `<input>`, not `aria-label`
- `ViewPicker` disabled options need `aria-disabled` + tooltip text
  duplicated as `aria-describedby`

## Top 3 pitfalls

1. **Recomputing `filteredBench` on every keystroke.** The Player
   re-mounts on `inputProps` identity change, which restarts playback.
   Memoise on `(bench, range, selected)` and never inline-object the
   prop.

2. **Treating "excluded" providers as the source of truth.** When the
   bench refreshes (new provider added upstream), an exclusion list
   silently opts them in. Use selection — explicit, serialisable,
   future-proof.

3. **Letting render state leak into config state.** Keep two reducers.
   If they merge, a re-render during rendering will re-fire effects
   that re-trigger the render. Seen this kill three prototypes.
