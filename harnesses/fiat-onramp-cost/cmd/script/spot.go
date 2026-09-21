package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"
)

// Spot references. Two, both keyless, both labelled on every sample.
//
// kraken_eur is the headline for EUR-denominated quotes: the persona pays
// in EUR, Kraken is the deepest EUR spot venue, and its XBT/EUR mid carries
// a 0.02 bps spread, so the reference is not itself a source of error at
// the 10 to 300 bps scale the bench measures. pyth is the cross-check,
// reusing what the USDY NAV-basis bench (078) already consumes. Pyth has no
// BTC/EUR feed, so its EUR price is BTC/USD divided by EUR/USD, one FX leg
// the Kraken mid does not have. That is why it is not the headline.
//
// Both are fetched in the same cycle as the quotes; the sample timestamp
// is recorded so a reader can check the ±2 s co-timing claim.

type SpotSnapshot struct {
	At     time.Time
	Kraken map[string]float64 // asset → EUR mid
	Pyth   map[string]float64 // asset → EUR (USD price / EURUSD)
}

// Kraken pair names as returned in the Ticker result keys.
var krakenPairs = map[string]string{"btc": "XXBTZEUR", "eth": "XETHZEUR", "usdc": "USDCEUR"}

// Pyth Hermes feed ids, verified on hermes.pyth.network/v2/price_feeds on
// 2026-09-10. Crypto.BTC/USD, Crypto.ETH/USD, Crypto.USDC/USD, FX.EUR/USD.
var pythFeeds = map[string]string{
	"btc":    "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
	"eth":    "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
	"usdc":   "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
	"eurusd": "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
}

func krakenTickerURL() string {
	return baseFor("kraken", "https://api.kraken.com") + "/0/public/Ticker?pair=XBTEUR,ETHEUR,USDCEUR"
}
func pythHermesURL() string {
	return baseFor("pyth", "https://hermes.pyth.network") + "/v2/updates/price/latest"
}

func fetchKraken(ctx context.Context) (map[string]float64, error) {
	res, err := doJSON(ctx, "GET", krakenTickerURL(), nil, nil)
	if err != nil {
		return nil, err
	}
	if res.Status != 200 {
		return nil, fmt.Errorf("kraken status %d", res.Status)
	}
	return parseKraken(res.Body)
}

func parseKraken(body []byte) (map[string]float64, error) {
	var env struct {
		Error  []string `json:"error"`
		Result map[string]struct {
			A []string `json:"a"`
			B []string `json:"b"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, err
	}
	if len(env.Error) > 0 {
		return nil, fmt.Errorf("kraken: %v", env.Error)
	}
	out := map[string]float64{}
	for asset, pair := range krakenPairs {
		t, ok := env.Result[pair]
		if !ok || len(t.A) == 0 || len(t.B) == 0 {
			continue
		}
		ask, e1 := strconv.ParseFloat(t.A[0], 64)
		bid, e2 := strconv.ParseFloat(t.B[0], 64)
		if e1 != nil || e2 != nil || ask <= 0 || bid <= 0 {
			continue
		}
		out[asset] = (ask + bid) / 2
	}
	if len(out) == 0 {
		return nil, errors.New("kraken: no usable pair")
	}
	return out, nil
}

func fetchPyth(ctx context.Context) (map[string]float64, error) {
	url := pythHermesURL() + "?parsed=true"
	for _, id := range pythFeeds {
		url += "&ids[]=" + id
	}
	// Hermes requires a key since the Pyth Core upgrade of 2026-08-26
	// (docs.pyth.network, "Hermes now requires an API Key"). Without one the
	// call returns 401 and the pyth reference is simply absent this cycle;
	// kraken_eur, the headline, does not depend on it.
	var hdr map[string]string
	if k := env("PYTH_API_KEY", ""); k != "" {
		hdr = map[string]string{"Authorization": "Bearer " + k}
	}
	res, err := doJSON(ctx, "GET", url, hdr, nil)
	if err != nil {
		return nil, err
	}
	if res.Status == 401 {
		return nil, errors.New("pyth: 401, set PYTH_API_KEY (required since 2026-08-26)")
	}
	if res.Status != 200 {
		return nil, fmt.Errorf("pyth status %d", res.Status)
	}
	return parsePyth(res.Body)
}

func parsePyth(body []byte) (map[string]float64, error) {
	var env struct {
		Parsed []struct {
			ID    string `json:"id"`
			Price struct {
				Price string `json:"price"`
				Expo  int    `json:"expo"`
			} `json:"price"`
		} `json:"parsed"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, err
	}
	byID := map[string]float64{}
	for _, p := range env.Parsed {
		v, err := strconv.ParseFloat(p.Price.Price, 64)
		if err != nil {
			continue
		}
		byID[p.ID] = v * pow10(p.Price.Expo)
	}
	eurusd := byID[pythFeeds["eurusd"]]
	if eurusd <= 0 {
		return nil, errors.New("pyth: EUR/USD missing")
	}
	out := map[string]float64{}
	for _, a := range []string{"btc", "eth", "usdc"} {
		if usd := byID[pythFeeds[a]]; usd > 0 {
			out[a] = usd / eurusd
		}
	}
	if len(out) == 0 {
		return nil, errors.New("pyth: no usable feed")
	}
	return out, nil
}

func pow10(e int) float64 {
	r := 1.0
	if e >= 0 {
		for i := 0; i < e; i++ {
			r *= 10
		}
		return r
	}
	for i := 0; i < -e; i++ {
		r /= 10
	}
	return r
}

// fetchSpot gathers both references in parallel. A missing reference is not
// fatal: the premium is emitted only for the references that answered, and
// the label says which.
func fetchSpot(ctx context.Context) SpotSnapshot {
	snap := SpotSnapshot{At: time.Now().UTC()}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if k, err := fetchKraken(ctx); err == nil {
			snap.Kraken = k
		} else {
			fmt.Printf("[SPOT] kraken: %v\n", err)
		}
	}()
	go func() {
		defer wg.Done()
		if p, err := fetchPyth(ctx); err == nil {
			snap.Pyth = p
		} else {
			fmt.Printf("[SPOT] pyth: %v\n", err)
		}
	}()
	wg.Wait()
	for a, v := range snap.Kraken {
		spotPrice.WithLabelValues(a, PersonaFiat, "kraken_eur").Set(v)
	}
	for a, v := range snap.Pyth {
		spotPrice.WithLabelValues(a, PersonaFiat, "pyth").Set(v)
		if k := snap.Kraken[a]; k > 0 {
			spotDivergence.WithLabelValues(a, PersonaFiat).Set((k - v) / v * 1e4)
		}
	}
	return snap
}
