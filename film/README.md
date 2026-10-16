# OpenChainBench film

A brand film rendered from the live API. Every figure on screen is a number the
site is publishing, pulled by a script and committed, so a render is
reproducible and every claim is dated.

```bash
cd film
npm install
npm run data        # refresh src/data.ts + public/logos from openchainbench.com/api
npm run studio      # preview and scrub
npm run render      # out/ocb-film.mp4
```

## Why each act looks different

The first version of this film ran the same bar chart for every benchmark and
became a list: by the third table the eye has learned the shape and stops
reading. Each act is now drawn from what its bench actually measures, so the
form carries information instead of repeating it.

| Act | Bench | Shape | Why |
|---|---|---|---|
| Aggregators | `aggregator-head-lag` | `lag` | Arrivals on one shared clock. A provider's marker lands at the moment its measured lag says it should, so the film's own timing is the measurement. |
| Trading | `terminal-swap-transactions` | `volume` | Accumulation into columns. Throughput is mass, not speed, so it piles up instead of racing. |
| Bridges | `bridge-fee` | `fee` | Subtraction from a $10,000 transfer. The spread between best and worst is about eighteen dollars, which is legible in dollars and invisible as a percentage bar. |
| Blockchains | `l2-block-time` | `tempo` | The measurement played at 1:1, one tick per block, for four seconds. Robinhood Chain fires forty ticks, Blast fires two. |
| RPCs | 165 chain benchmarks | grid | The claim is breadth, so the picture is every chain at once. |

Adding an act means adding an entry to `ACTS` in `scripts/fetch-data.ts` and a
component in `src/acts/`. The shape is declared in the data, and `Film.tsx`
maps it to a component, so the cut never has to know what a bench is about.

## Where the numbers come from

`scripts/fetch-data.ts` reads two public endpoints:

- `/api/citable` for the totals and the RPC leader tally
- `/api/stat/<slug>` for each act's full ranked field, not just the winner

Three things it handles that are easy to get wrong:

- **Latency benches that declare `s` store milliseconds.** The site has the same
  conversion in `src/lib/format.ts`. Skipping it prints a 0.26 s head lag as
  "260 s".
- **The category copy is the site's own**, read from `src/lib/categories.ts` so
  the film cannot describe a category differently from the category page.
- **Only the logos the film references are copied** into `public/logos`, so the
  directory stays reviewable.

## Rendering

The three.js scenes need a GL context. On a box with no GPU, pass
`--gl=swangle` (already set in `remotion.config.ts`); without it every frame
containing the logo sphere fails with `Error creating WebGL context`.

Rendering on the Singapore box, which has 64 cores:

```bash
rsync -az --exclude node_modules --exclude out film/ ubuntu@<host>:~/ocb-film/
ssh ubuntu@<host> 'cd ~/ocb-film && npm install && npx remotion render src/index.ts OCBFilm out/ocb-film.mp4 --gl=swangle --concurrency=16'
```

Concurrency is capped deliberately: that machine also runs two blockchain
nodes, and Remotion will take every core it is offered.

Remotion's default output has one keyframe per ten seconds, which makes
scrubbing look frozen in light players. For anything that gets shared:

```bash
ffmpeg -i out/ocb-film.mp4 -c:v libx264 -preset slow -crf 17 \
  -profile:v high -level 4.0 -pix_fmt yuv420p \
  -g 30 -keyint_min 30 -sc_threshold 0 -movflags +faststart -an out/share.mp4
```

## Known gaps

- **No audio.** A licensed track is the single biggest quality lift left, and
  not something to improvise with an unlicensed file.
- **16:9 only.** Type sizes and padding are tuned for 1920x1080; rendering the
  same tree at 1080x1920 overflows rather than reflowing, so a vertical cut
  needs its own layout pass rather than a second `<Composition>`.
- **Mobula appears in two acts**, as the head-lag leader and in the bridge fee
  field. Those are the real standings, but OpenChainBench is a Mobula project,
  so it is worth a conscious decision rather than a default.

## Licence

The measurements are CC BY 4.0, like the rest of the site. Brand marks in
`public/logos` belong to their owners and are used to identify the products
measured.
