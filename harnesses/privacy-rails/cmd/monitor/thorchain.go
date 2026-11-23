package main

import (
	"fmt"
	"strconv"
	"time"
)

// THORChain, the third rail, and the one that took longest to reach.
//
// Twelve hostnames were tried before this and not one existed: neither the
// system resolver nor 8.8.8.8 had an A record for thornode.ninerealms.com,
// midgard.ninerealms.com, thornode.thorchain.info or seed.thorchain.info.
// The root domains resolve fine, so the names were invented, not dead.
//
// The working host came from the Cosmos chain-registry, which the chain's
// own operators maintain:
//
//	raw.githubusercontent.com/cosmos/chain-registry/master/thorchain/chain.json
//
// One request to a registry would have replaced a dozen guesses. The lesson
// is in the override below: THOR_BASE exists so the next operator change
// costs an environment variable rather than another round of guessing.
//
// Its schema is the one Maya forked, so the quote parser is shared.
//
// What it carries is the interesting part. ZEC.ZEC is Available, and on
// 2026-10-26 its pool held 22.59 ZEC against Maya's 2,233: two orders of
// magnitude thinner on the same asset. A board that lists both without the
// depth beside them would invite the reader to think they are alternatives.
var thorAssets = []string{"ZEC.ZEC"}

func thorQuote(cfg *Config, from, to string, amount int64, dest string) (*mayaQuote, int, error) {
	url := fmt.Sprintf("%s/thorchain/quote/swap?from_asset=%s&to_asset=%s&amount=%d",
		cfg.ThorBase, from, to, amount)
	if dest != "" {
		url += "&destination=" + dest
	}
	var q mayaQuote
	code, err := getJSON(url, &q)
	return &q, code, err
}

// probeThorRoundTrip mirrors the Maya probe: BTC in, privacy asset, BTC back,
// both legs on the same tick and nothing published unless both answer.
func probeThorRoundTrip(cfg *Config, asset string) {
	var costs, secs []float64
	for _, t := range tiers {
		lbl := []string{"thorchain", asset, t.Bucket, cfg.MonitorRegion}

		in, _, err := thorQuote(cfg, "BTC.BTC", asset, t.SatIn, "")
		if err != nil {
			probeTotal.WithLabelValues("thorchain", "round_trip", "transport_error").Inc()
			continue
		}
		mid, err := in.out()
		if err != nil {
			probeTotal.WithLabelValues("thorchain", "round_trip", "leg1_refused").Inc()
			continue
		}
		back, _, err := thorQuote(cfg, asset, "BTC.BTC", mid, "")
		if err != nil {
			probeTotal.WithLabelValues("thorchain", "round_trip", "transport_error").Inc()
			continue
		}
		outSat, err := back.out()
		if err != nil {
			probeTotal.WithLabelValues("thorchain", "round_trip", "leg2_refused").Inc()
			continue
		}

		lost := float64(t.SatIn-outSat) / float64(t.SatIn) * 10000
		if lost < 0 {
			probeTotal.WithLabelValues("thorchain", "round_trip", "negative_cost").Inc()
			continue
		}
		roundTripBps.WithLabelValues(lbl...).Set(lost)
		eta := float64(in.TotalSwapSeconds + back.TotalSwapSeconds)
		roundTripSec.WithLabelValues(lbl...).Set(eta)
		streamSeconds.WithLabelValues(lbl...).Set(float64(in.StreamingSeconds + back.StreamingSeconds))
		costs = append(costs, lost)
		secs = append(secs, eta)
		probeTotal.WithLabelValues("thorchain", "round_trip", "ok").Inc()
		lastSuccess.WithLabelValues("thorchain", "round_trip").Set(float64(time.Now().Unix()))
	}
	publishPooled("thorchain", asset, cfg.MonitorRegion, costs, secs)
}

type thorPool struct {
	Asset        string `json:"asset"`
	Status       string `json:"status"`
	BalanceAsset string `json:"balance_asset"`
}

// probeThorDepth publishes the liquidity behind the cost, which on this rail
// is the whole story: 22.59 ZEC when first measured, against 2,233 on Maya.
func probeThorDepth(cfg *Config) {
	var pools []thorPool
	if _, err := getJSON(cfg.ThorBase+"/thorchain/pools", &pools); err != nil {
		probeTotal.WithLabelValues("thorchain", "depth", "transport_error").Inc()
		return
	}
	want := map[string]bool{}
	for _, a := range thorAssets {
		want[a] = true
	}
	for _, p := range pools {
		if !want[p.Asset] || p.Status != "Available" {
			continue
		}
		if d, err := strconv.ParseFloat(p.BalanceAsset, 64); err == nil {
			poolDepth.WithLabelValues("thorchain", p.Asset).Set(d / 1e8)
		}
	}
	probeTotal.WithLabelValues("thorchain", "depth", "ok").Inc()
	lastSuccess.WithLabelValues("thorchain", "depth").Set(float64(time.Now().Unix()))
}

// probeThorDelivery asks the same question as the other rails: can it pay a
// shielded address. THORChain routes the destination the way Maya does, so
// the expectation is a refusal, but it is measured rather than inherited:
// the two codebases have diverged and an assumption about one is not a
// measurement of the other.
func probeThorDelivery(cfg *Config) {
	probeDelivery(cfg, "thorchain", "bitcoin", func(recipient string) (bool, string, error) {
		q, code, err := thorQuote(cfg, "BTC.BTC", "ZEC.ZEC", 10_000_000, recipient)
		if err != nil && code == 0 {
			return false, "", err
		}
		if q.Error != "" {
			return false, q.Error, nil
		}
		if _, e := q.out(); e != nil {
			return false, e.Error(), nil
		}
		return true, "", nil
	})
}
