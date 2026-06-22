# HF dataset publisher

Daily snapshot publisher for the public
[OpenChainBench/benchmarks](https://huggingface.co/datasets/OpenChainBench/benchmarks)
dataset on Hugging Face.

## What it does

- Fetches `https://openchainbench.com/api/citable` and
  `/api/stat/<slug>` for every live bench.
- Refuses to publish if the source feed is degraded (quorum guard: half
  the count below `live` status, or count below the floor).
- Projects the JSON into three Hive-partitioned Parquet tables:
  - `headlines/` 1 row per (slug, day)
  - `providers/` 1 row per (slug, provider, day)
  - `timeseries/` 1 row per (slug, point, day)
- Stages a fixed set of static assets (README, CITATION.cff, LICENSE,
  JSON schemas, example queries) and pushes the whole thing to HF.

## Schema versioning

`SCHEMA_VERSION` in `publish.py` is the source of truth. Bump it any
time a column is added. **Never** rename or remove columns: the dataset
is a long-lived public artifact and consumers will write queries
against the column names.

## Local dry-run

```bash
cd scripts/hf_publisher
pip install -r requirements.txt
python publish.py --dry-run --out /tmp/ocb-hf-test
ls /tmp/ocb-hf-test
```

## CI

The `.github/workflows/hf-publish.yml` workflow runs the tests first,
then either `publish.py --dry-run` (manual dispatch with the flag) or
the real push (scheduled run or manual without the flag).

Required GitHub secrets:
- `HF_TOKEN` write-scoped token on the dataset repo.
- `SLACK_WEBHOOK_URL` optional incoming-webhook URL for ops alerts.

## Tests

```bash
cd scripts/hf_publisher
python -m unittest test_publish.py -v
```

Tests cover the quorum guard, all three row builders, the partition
path layout, and the static-asset templating step. They never hit the
live API or HF Hub.
