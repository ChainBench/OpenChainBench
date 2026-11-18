package main

import "testing"

// The subscription must name the same pool the race scores on each chain,
// or every Metastreams emission is off-pool and nothing is measured.
func TestMetastreamsPoolsMatchBenchPools(t *testing.T) {
	bench := map[string]string{}
	for _, p := range headLagPools {
		bench[p.ChainName] = p.Address
	}
	for _, c := range metastreamsChains {
		want, ok := bench[c.ChainName]
		if !ok {
			t.Fatalf("%s is not a bench chain", c.ChainName)
		}
		if want != c.Pool {
			t.Errorf("%s: subscribes to %s, bench pool is %s", c.ChainName, c.Pool, want)
		}
	}
}
