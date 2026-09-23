package main

import (
	"fmt"
	"net/http"
	"time"
)

func main() {
	installLogCapture()
	fmt.Println("=== RWA Solana Depth Harness ===")
	fmt.Println("OpenChainBench — what $1k, $10k and $100k of a tokenized RWA sell for on Solana.")
	fmt.Printf("Cohort: %d assets | poll: %s | Jupiter lite-api | RPC host: %s\n", len(assets), pollInterval, rpcHost())
	for _, a := range assets {
		kind := "routed"
		if !a.Routed {
			kind = "no open market"
		}
		fmt.Printf("  - %-7s %-10s %s (%s)\n", a.Name, a.Issuer, a.Mint, kind)
	}

	go func() {
		if err := startMetricsServer(listenAddr()); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
		}
	}()

	client := &http.Client{Timeout: httpTimeout}
	lastPrice := map[string]float64{}
	lastPriceAt := map[string]time.Time{}
	lastSupply := time.Time{}
	supplyRaw := map[string]float64{}

	tick := func() {
		now := time.Now()
		// Half a tick of tolerance: the tick's own duration made an exact
		// comparison skip one supply read in three (review 2 2026-09-23).
		if now.Sub(lastSupply) >= supplyInterval-pollInterval/2 {
			n := 0
			for _, a := range assets {
				raw, ui, ok := tokenSupply(client, a.Mint)
				if !ok {
					// A failed read publishes nothing: a held supply would be
					// re-valued at every new price and counted in the hub's
					// totals for as long as the RPC stays down (review 2026-09-23).
					delete(supplyRaw, a.Slug)
					supplyUnits.DeleteLabelValues(a.Slug, a.Issuer)
					supplyUSD.DeleteLabelValues(a.Slug, a.Issuer)
					continue
				}
				supplyRaw[a.Slug] = raw
				supplyUnits.WithLabelValues(a.Slug, a.Issuer).Set(ui)
				if a.NavUSD > 0 {
					supplyUSD.WithLabelValues(a.Slug, a.Issuer).Set(ui * a.NavUSD)
				}
				n++
			}
			lastSupply = now
			fmt.Printf("[supply] %d of %d mints read from %s\n", n, len(assets), rpcHost())
		}

		for _, a := range assets {
			if !a.Routed {
				routed, confirmed := probeRoute(client, a)
				depthRouteOK.WithLabelValues(a.Slug, a.Issuer).Set(0)
				if routed {
					// A market appeared: say so loudly, keep the row unranked
					// until the config moves it to the routed set.
					fmt.Printf("[%s] a Jupiter route exists now; move the asset to the routed set\n", a.Name)
				}
				if confirmed || routed {
					depthHealth.WithLabelValues(a.Slug).Set(1)
					depthLastSuccess.WithLabelValues(a.Slug).Set(float64(time.Now().Unix()))
				} else {
					depthHealth.WithLabelValues(a.Slug).Set(0)
				}
				continue
			}
			res, price := measureDepth(client, a, lastPrice[a.Slug])
			if price > 0 {
				lastPrice[a.Slug] = price
				lastPriceAt[a.Slug] = time.Now()
			}
			for _, s := range sizes {
				if v, ok := res.CostBps[s.Suffix]; ok {
					depthCost[s.Suffix].WithLabelValues(a.Slug, a.Issuer).Set(v)
				} else {
					depthCost[s.Suffix].DeleteLabelValues(a.Slug, a.Issuer)
				}
			}
			if res.Route100k {
				depthRouteOK.WithLabelValues(a.Slug, a.Issuer).Set(1)
				depthFill.WithLabelValues(a.Slug, a.Issuer).Set(res.Fill100k)
			} else {
				depthRouteOK.WithLabelValues(a.Slug, a.Issuer).Set(0)
				depthFill.DeleteLabelValues(a.Slug, a.Issuer)
			}
			if res.PriceUSD > 0 {
				depthPrice.WithLabelValues(a.Slug, a.Issuer).Set(res.PriceUSD)
				if raw, ok := supplyRaw[a.Slug]; ok {
					perRaw := res.PriceUSD / pow10(a.Decimals)
					supplyUSD.WithLabelValues(a.Slug, a.Issuer).Set(raw * perRaw)
				}
			} else {
				// No executable price this tick. The supply keeps the last good
				// price for up to two ticks (one failed $100 quote must not blank
				// the hub's totals), then the USD value goes; the unit supply
				// stays, it is a chain read.
				depthPrice.DeleteLabelValues(a.Slug, a.Issuer)
				raw, haveRaw := supplyRaw[a.Slug]
				if p, ok := lastPrice[a.Slug]; ok && haveRaw && time.Since(lastPriceAt[a.Slug]) <= 2*pollInterval {
					supplyUSD.WithLabelValues(a.Slug, a.Issuer).Set(raw * p / pow10(a.Decimals))
				} else {
					supplyUSD.DeleteLabelValues(a.Slug, a.Issuer)
				}
			}
			if res.Route100k {
				depthHealth.WithLabelValues(a.Slug).Set(1)
				depthLastSuccess.WithLabelValues(a.Slug).Set(float64(time.Now().Unix()))
				fmt.Printf("[%s] price=%.4f cost 1k=%.1f 10k=%.1f 100k=%.1f bps fill100k=%.0f\n",
					a.Name, res.PriceUSD, res.CostBps["1k"], res.CostBps["10k"], res.CostBps["100k"], res.Fill100k)
			} else {
				depthHealth.WithLabelValues(a.Slug).Set(0)
				if res.NoRoute {
					fmt.Printf("[%s] no route this tick\n", a.Name)
				} else {
					fmt.Printf("[%s] quote failed this tick\n", a.Name)
				}
			}
		}
	}

	tick()
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for range t.C {
		tick()
	}
}

func pow10(n int) float64 {
	v := 1.0
	for i := 0; i < n; i++ {
		v *= 10
	}
	return v
}
