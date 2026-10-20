# Video lab: iterate on renders against frozen fixtures

Every change to a composition is judged on the same ten real benches,
frozen as JSON, before anything ships.

```bash
npm i --no-save sharp@0.33.5          # the lab scripts need sharp; the server does not
python3 lab/fetch_fixtures.py          # refresh lab/fixtures from openchainbench.com/api/series (30d, as the modal)
FORMAT=landscape CONC=16 node lab/stills.mjs lab/fixtures lab/out/landscape 12   # key frames, ~35 s on the 64-core box
node lab/contact.mjs lab/out/landscape lab/out/sheets-landscape                  # one contact sheet per fixture
node lab/compare.mjs <base frames> <cand frames> <base sheets> <cand sheets> <out>   # before/after + changed.tsv
node lab/checks.mjs lab/out/landscape lab/fixtures                                 # automatic gate, exit 1 on any FAIL
node lab/review.mjs lab/out/review lab/fixtures v24=<round dir> v25=<round dir>    # strips + data.json for the review page
```

## The loop

1. Change one part (a composition).
2. Render both formats into a round directory (`<round>/landscape`, `<round>/short`)
   and run `checks.mjs` on each. A FAIL is fixed before anyone looks at it.
3. `review.mjs` with the previous round and the new one builds the strips; the
   review page shows them side by side, with the FAIL boxes drawn in red, and
   takes an OK/KO verdict per part.
4. Ship only parts that are OK, bumping `COMP_VERSION`.

## What the checks measure

Stills are rendered with `inputProps.lab = true`, which mounts
`src/lib/lab-probe.tsx`: it measures every visible line of text, every value
label (`data-lab-value`) and every logo chip (`data-lab-chip`) in the real
browser and prints them as one console line. `checks.mjs` reads that, the PNG
and the fixture:

| Code | Level | Meaning |
|---|---|---|
| OUT_OF_FRAME | FAIL | readable text runs past the frame edge |
| OVERLAP | FAIL | two readable texts cover each other (ink box, not line box) |
| BAD_TEXT | FAIL | NaN, undefined, Infinity or e-notation on screen |
| EMOJI | FAIL | an emoji: neither render box has an emoji font, it prints as a box |
| VALUE_RANGE | FAIL | a value outside anything the data can produce (unit bugs) |
| LOGO_EMPTY | FAIL | a logo chip whose image did not load |
| LOGO_FALLBACK | WARN | initials shown for a provider that has a logo |
| LOGO_CONTRAST | WARN | under 4% of the logo stands out from its chip |
| CLIPPED | WARN | readable text cut by its container |
| TINY_TEXT | WARN | text under 22 px, unreadable on a phone |

The value parser is written independently of `formatters.ts`, so a formatter
bug shows up as VALUE_RANGE instead of agreeing with itself.

`FORMAT=short` renders 1080x1920 like the server's `short` format. `stills.mjs`
passes the same inputProps the server does (`theme`, `bench`, `beats`).

Fixtures cover the edge cases that broke before: seconds benches
(`headlag-seconds`), sub-cent dollars (`netfees-tiny`), 12 and 20 providers,
counts in the millions, percentages, few providers.

Render on the Singapore box (64 cores), not on the Paris renderer (2 vCPU).
Pass `--gl=swangle` semantics through `chromiumOptions` (already set): there is
no GPU there.
