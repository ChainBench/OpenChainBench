package main

// crosscheck.go is intentionally minimal: the divergence comparison is
// folded into Router.Sweep in adapter.go so we can use the same
// per-source results without re-running fetches. This file exists as
// a placeholder so future divergence policy (per-metric thresholds,
// rolling-window smoothing) has an obvious home.
//
// Today's policy:
//   - threshold 10 percent (|a-b|/max(a,b) > 0.10) increments
//     perp_cohort_stats_data_divergence_total{venue, metric}
//   - cross-check fires only when BOTH primary and secondary sources
//     returned non-zero values; "secondary missing" is not a divergence,
//     it is just a single-source publication.
//   - divergence is a counter, not a publishing gate: the primary
//     winner is published regardless, the counter just flags the case
//     so the UI / dashboards can surface "two sources disagree".
