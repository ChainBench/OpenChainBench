# OpenChainBench video engine

The Remotion compositions and the render server behind the "Export video"
modal on bench pages.

```
bench page modal ──POST /api/video/render──▶ site route (src/app/api/video/render)
                                               │  validates, adds X-Render-Token
                                               ▼
                         https://video.openchainbench.com/render
                         Paris VPS 57.130.19.92 (ssh -p 8822 rescue@…)
                         pm2 app `video-renderer`, /mnt/video-renderer, port 4200
                                               │  intro + race + results + outro,
                                               │  ffmpeg concat, content-addressed cache
                                               ▼
                         nginx serves /v/<hash>.mp4 from /mnt/video-renderer/cache
```

| Path | What it is | On the server |
|---|---|---|
| `src/` | compositions: BarChartRace, TimeSeriesRace, DistributionRace, DonutRace, CountPodium, ResultsBoard, Intro, Outro | `/mnt/video-renderer/poc/src` |
| `server/server.mjs` | the Express render server (auth, rate limit, queue of 2, cache) | `/mnt/video-renderer/server.mjs` |
| `public/` | intro clips, logo texture, grain | `/mnt/video-renderer/poc/public` |
| `lab/` | fixtures, stills, contact sheets, before/after (see below) | not deployed |

The payload contract is `BenchPayload` in `src/lib/export-video/types.ts` of the
site and `src/types/bench.ts` here. Values arrive as `/api/series` emits them
without `?raw=1`: **seconds for `s` benches, percent for `bps`**.

## Iterating on a composition

Never judge a change on one hand-picked bench. The lab renders the same ten
real benches, frozen as JSON, before and after:

```bash
cd video
python3 lab/fetch_fixtures.py        # only when the fixtures should move
# on the Singapore box (64 cores): ~35 s per format
FORMAT=landscape CONC=16 node lab/stills.mjs lab/fixtures lab/out/landscape 12
node lab/contact.mjs lab/out/landscape lab/out/sheets-landscape
node lab/compare.mjs <base frames> <cand frames> <base sheets> <cand sheets> lab/out/cmp
```

`FORMAT=short` renders 1080x1920 like the server's `short` format. The
fixtures cover what broke before: a seconds bench, sub-cent dollars, 12 and
20 providers, counts in the millions, percentages, few providers.

## Deploying

```bash
bash video/deploy/deploy-renderer.sh            # ships video/ at origin/dev
```

It archives the committed tree (never a working copy), backs up the live
code and bundle, builds the new bundle beside the live one, swaps, restarts,
checks `/health` reports the new `COMP_VERSION`, and rolls back otherwise.

**Bump `COMP_VERSION` in `server/server.mjs` with every composition change.**
The cache key includes it; without a bump the server keeps answering with
videos rendered by the previous code.

## Not in this repository

- `public/ambient-benchmark.mp3` (and `-original.mp3`), the soundtrack used
  when a render asks for audio. Its licence has not been established for a
  public repository, so it stays on the server only; the deploy script never
  deletes it.
- `.env` with `RENDER_API_TOKEN`, on the server only. The site holds the same
  token as `RENDER_API_TOKEN` and the URL as `VIDEO_RENDERER_URL`.

## History

Built as a separate repository (github.com/Flotapponnier/openbench_video_generator),
then edited in place on the server from June to October 2026, so production
drifted from its own repo. It moved here on 2026-10-19 from the production
tree, with the Next.js test panel left behind (the site's modal replaces it).
