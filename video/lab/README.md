# Video lab: iterate on renders against frozen fixtures

Every change to a composition is judged on the same ten real benches,
frozen as JSON, before anything ships.

```bash
python3 lab/fetch_fixtures.py          # refresh lab/fixtures from openchainbench.com/api/series (30d, as the modal)
FORMAT=landscape CONC=16 node lab/stills.mjs lab/fixtures lab/out/landscape 12   # key frames, ~35 s on the 64-core box
node lab/contact.mjs lab/out/landscape lab/out/sheets-landscape                  # one contact sheet per fixture
node lab/compare.mjs <base frames> <cand frames> <base sheets> <cand sheets> <out>   # before/after + changed.tsv
```

`FORMAT=short` renders 1080x1920 like the server's `short` format. `stills.mjs`
passes the same inputProps the server does (`theme`, `bench`, `beats`).

Fixtures cover the edge cases that broke before: seconds benches
(`headlag-seconds`), sub-cent dollars (`netfees-tiny`), 12 and 20 providers,
counts in the millions, percentages, few providers.

Render on the Singapore box (64 cores), not on the Paris renderer (2 vCPU).
Pass `--gl=swangle` semantics through `chromiumOptions` (already set): there is
no GPU there.
