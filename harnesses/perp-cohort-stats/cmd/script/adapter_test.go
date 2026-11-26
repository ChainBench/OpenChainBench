package main

import (
	"errors"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

type stubSource struct {
	name   string
	values map[string]map[string]float64
}

func (s *stubSource) Name() string { return s.name }

func (s *stubSource) Fetch() (*SourceResult, error) {
	if s.values == nil {
		return nil, errors.New("unreachable")
	}
	return &SourceResult{Values: s.values}, nil
}

func TestSweep_CarryKeepsStamp(t *testing.T) {
	hl := &stubSource{name: srcHLNative}
	llama := &stubSource{name: srcDefillama}
	clock := time.Unix(1_000, 0)
	r := NewRouter(&Config{}, func() time.Time { return clock })
	r.sources = []Source{hl, llama}

	llama.values = map[string]map[string]float64{
		"hyperliquid": {mVolume24h: 9e9, mFees30d: 5e7},
	}
	r.Sweep()

	clock = time.Unix(2_000, 0)
	llama.values = map[string]map[string]float64{
		"hyperliquid": {mVolume24h: 8e9},
	}
	r.Sweep()

	stamp := func(metric string) float64 {
		return testutil.ToFloat64(
			perpVenueMetricRefreshUnix.WithLabelValues("hyperliquid", metric),
		)
	}
	if got := stamp(mVolume24h); got != 2_000 {
		t.Errorf("volume_24h stamp = %v, want 2000", got)
	}
	if got := stamp(mFees30d); got != 1_000 {
		t.Errorf("fees_30d stamp = %v, want 1000", got)
	}
}
