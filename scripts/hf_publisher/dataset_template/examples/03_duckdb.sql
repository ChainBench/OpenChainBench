-- DuckDB can read Parquet directly from Hugging Face over httpfs.
-- Install once:
--   INSTALL httpfs; LOAD httpfs;
-- Then run any query like the ones below.

-- 1) Today's leader per benchmark, sorted by sample size
WITH latest AS (
  SELECT max(snapshot_date) AS d
  FROM 'hf://datasets/OpenChainBench/benchmarks/headlines/**/*.parquet'
)
SELECT slug, leader_name, value, unit, sample_size
FROM 'hf://datasets/OpenChainBench/benchmarks/headlines/**/*.parquet'
WHERE snapshot_date = (SELECT d FROM latest)
ORDER BY sample_size DESC;

-- 2) 7-day p50 trend for one bench / one provider
SELECT snapshot_date, p50, p90, p99, success_rate
FROM 'hf://datasets/OpenChainBench/benchmarks/providers/**/*.parquet'
WHERE bench_slug = 'bridge-quote-latency'
  AND provider_slug = 'mobula'
ORDER BY snapshot_date DESC
LIMIT 7;

-- 3) Sparkline for today, one bench
SELECT point_index, value
FROM 'hf://datasets/OpenChainBench/benchmarks/timeseries/**/*.parquet'
WHERE bench_slug = 'bridge-quote-latency'
  AND snapshot_date = (
    SELECT max(snapshot_date)
    FROM 'hf://datasets/OpenChainBench/benchmarks/timeseries/**/*.parquet'
  )
ORDER BY point_index;
