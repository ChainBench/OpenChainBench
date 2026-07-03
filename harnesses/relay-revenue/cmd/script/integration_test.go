package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestIntegration_RealRelayData(t *testing.T) {
	if os.Getenv("MOBULA_API_KEY") == "" {
		t.Skip("MOBULA_API_KEY not set")
	}
	pricer := buildPricer()
	client := &http.Client{Timeout: 15 * time.Second}

	type page struct {
		Requests     []RelayRequest `json:"requests"`
		Continuation string         `json:"continuation"`
	}
	cont := ""
	total := 0
	priced := 0
	dropBy := map[string]int{}
	dropExamples := map[string]string{}
	for p := 0; p < 4; p++ {
		url := "https://api.relay.link/requests?limit=50&status=success"
		if cont != "" {
			url += "&continuation=" + cont
		}
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("User-Agent", "mobula-openchainbench/integration")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("fetch: %v", err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var pg page
		_ = json.Unmarshal(body, &pg)
		for _, r := range pg.Requests {
			if r.Status != "success" {
				continue
			}
			total++
			ctx := context.Background()
			sw, _ := ComputeMargin(ctx, r, pricer)
			if sw.Priced {
				priced++
				continue
			}
			// Categorize the drop. Probe each leg in isolation.
			d := r.Data
			tag := ""
			if _, ok := amountToUSD(ctx, pricer, d.Metadata.CurrencyIn); !ok {
				tag = "in:" + dropTag(d.Metadata.CurrencyIn.Currency)
			} else if _, ok := amountToUSD(ctx, pricer, d.Metadata.CurrencyOut); !ok {
				tag = "out:" + dropTag(d.Metadata.CurrencyOut.Currency)
			} else if _, ok := sumGasUSD(ctx, pricer, d.InTxs, d.OutTxs); !ok {
				failing := []string{}
				for _, x := range append(append([]RelayTx{}, d.InTxs...), d.OutTxs...) {
					if x.Fee == "" || x.Fee == "0" {
						continue
					}
					cs, found := chainSpec(x.ChainID)
					if !found {
						failing = append(failing, fmt.Sprintf("chain%d=UNKNOWN", x.ChainID))
						continue
					}
					if _, pok := pricer.PriceUSD(ctx, cs.NativeCoingeckoID, cs.NativeSymbol); !pok {
						failing = append(failing, fmt.Sprintf("chain%d:%s/%s", x.ChainID, cs.NativeSymbol, cs.NativeCoingeckoID))
					}
				}
				tag = "gas:" + strings.Join(failing, ",")
			} else if _, ok := sumAppFeesUSD(ctx, pricer, d.AppFees); !ok {
				if len(d.AppFees) > 0 {
					tag = "appfee:" + dropTag(d.AppFees[0].Currency)
				} else {
					tag = "appfee:empty?"
				}
			} else {
				tag = "unknown"
			}
			dropBy[tag]++
			if _, exists := dropExamples[tag]; !exists {
				dropExamples[tag] = r.ID
			}
		}
		cont = pg.Continuation
		if cont == "" {
			break
		}
	}

	pct := float64(priced) / float64(total) * 100
	t.Logf("LIVE: %d/%d priced = %.1f %%", priced, total, pct)
	type kv struct {
		k string
		v int
	}
	var ranked []kv
	for k, v := range dropBy {
		ranked = append(ranked, kv{k, v})
	}
	sort.Slice(ranked, func(i, j int) bool { return ranked[i].v > ranked[j].v })
	t.Logf("DROP CAUSES (top 15):")
	for i, kv := range ranked {
		if i >= 15 {
			break
		}
		t.Logf("  %3d  %-50s  ex: %s", kv.v, kv.k, dropExamples[kv.k])
	}
}

func dropTag(c RelayCurrency) string {
	sym := c.Symbol
	if sym == "" {
		sym = "?"
	}
	addr := c.Address
	if len(addr) > 12 {
		addr = addr[:6] + "…" + addr[len(addr)-4:]
	}
	return fmt.Sprintf("chain=%d sym=%s addr=%s", c.ChainID, strings.ToUpper(sym), addr)
}
