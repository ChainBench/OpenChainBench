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
	lastSupply := time.Time{}
	supplyRaw := map[string]float64{}

	tick := func() {
		now := time.Now()
		if now.Sub(lastSupply) >= supplyInterval {
			n := 0
			for _, a := range assets {
				raw, ui, ok := tokenSupply(client, a.Mint)
				if !ok {
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
				depthPrice.DeleteLabelValues(a.Slug, a.Issuer)
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
