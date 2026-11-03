package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Shared plumbing for the chains added in the 2026-11 extension
// (Aptos, NEAR, Kaia, Algorand, ICP, Gram, Sei, Cronos) and for the
// chains whose scrapers were rewritten in the same pass (Sui, Cosmos
// Hub, Cardano, Avalanche). The older scrapers (Solana, Hyperliquid,
// Ethereum) keep their own inline Set calls.

const harnessUA = "OpenChainBench-harness/1.0"

const secondsPerYear = 365.25 * 24 * 3600

// getJSON GETs url and decodes the JSON body into out.
func getJSON(ctx context.Context, client *http.Client, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", harnessUA)
	return doJSON(client, req, out)
}

// postJSON POSTs payload as JSON to url and decodes the response.
func postJSON(ctx context.Context, client *http.Client, url string, payload any, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", harnessUA)
	return doJSON(client, req, out)
}

func doJSON(client *http.Client, req *http.Request, out any) error {
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		snippet := string(raw)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return fmt.Errorf("http %d from %s: %s", resp.StatusCode, req.URL.Host, snippet)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("parse %s: %w", req.URL.Host, err)
	}
	return nil
}

// jsonRPC calls a JSON-RPC 2.0 method and decodes `result` into out.
func jsonRPC(ctx context.Context, client *http.Client, url, method string, params any, out any) error {
	if params == nil {
		params = []any{}
	}
	var env struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	payload := map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
	if err := postJSON(ctx, client, url, payload, &env); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	if env.Error != nil {
		return fmt.Errorf("%s error %d: %s", method, env.Error.Code, env.Error.Message)
	}
	if len(env.Result) == 0 || string(env.Result) == "null" {
		return fmt.Errorf("%s: empty result", method)
	}
	return json.Unmarshal(env.Result, out)
}

// valRow is one published series for a chain: a validator, a pool,
// or a synthetic network-average row (Ethereum, Algorand, ICP).
type valRow struct {
	ID            string
	Name          string
	GrossBps      float64 // before commission and uptime
	NetBps        float64 // what a delegator / staker keeps
	CommissionBps float64 // -1 = unknown, gauge not written
	UptimePct     float64
	StakeNative   float64 // in whole tokens; USD = × price when known
	Jailed        bool
}

// publishedIDs remembers which (validator, name) pairs each chain
// wrote last cycle so a validator that leaves the cohort has its
// series deleted instead of lingering at its last value forever (a
// stale gauge would keep feeding the median-free p90/p99/mean
// queries, which read every series under the chain label).
var (
	publishedMu  sync.Mutex
	publishedIDs = map[string]map[[2]string]bool{}
)

var perValidatorVecs = []*prometheus.GaugeVec{
	validatorNetYieldBps, validatorGrossYieldBps, validatorMevShareBps,
	validatorCommissionBps, validatorUptimePct, validatorStakeUSD, validatorJailed,
}

// publishRows writes the per-validator gauges, the chain median, the
// tracked count and the freshness stamp for one chain. priceUSD <= 0
// skips the USD write (publish-then-leave, same rule as Ethereum).
func publishRows(chain string, rows []valRow, priceUSD float64) float64 {
	next := make(map[[2]string]bool, len(rows))
	nets := make([]float64, 0, len(rows))
	for _, r := range rows {
		name := shortenName(r.Name)
		next[[2]string{r.ID, name}] = true
		validatorNetYieldBps.WithLabelValues(chain, r.ID, name).Set(r.NetBps)
		validatorGrossYieldBps.WithLabelValues(chain, r.ID, name).Set(r.GrossBps)
		validatorMevShareBps.WithLabelValues(chain, r.ID, name).Set(0)
		if r.CommissionBps >= 0 {
			validatorCommissionBps.WithLabelValues(chain, r.ID, name).Set(clamp(r.CommissionBps, 0, 10000))
		}
		validatorUptimePct.WithLabelValues(chain, r.ID, name).Set(clamp(r.UptimePct, 0, 100))
		if priceUSD > 0 && r.StakeNative > 0 {
			validatorStakeUSD.WithLabelValues(chain, r.ID, name).Set(r.StakeNative * priceUSD)
		}
		jailed := 0.0
		if r.Jailed {
			jailed = 1
		}
		validatorJailed.WithLabelValues(chain, r.ID, name).Set(jailed)
		nets = append(nets, r.NetBps)
	}

	pruneLeavers(chain, next)

	med := medianBps(nets)
	chainTotalValidators.WithLabelValues(chain).Set(float64(len(rows)))
	chainMedianNetYieldBps.WithLabelValues(chain).Set(med)
	lastScrapeTimestamp.WithLabelValues(chain).Set(float64(time.Now().Unix()))
	return med
}

// pruneLeavers deletes the per-validator series of chain that were
// written last cycle but not this one. `next` holds (validator, name)
// pairs exactly as passed to WithLabelValues.
func pruneLeavers(chain string, next map[[2]string]bool) {
	publishedMu.Lock()
	defer publishedMu.Unlock()
	for key := range publishedIDs[chain] {
		if !next[key] {
			for _, vec := range perValidatorVecs {
				vec.DeleteLabelValues(chain, key[0], key[1])
			}
		}
	}
	publishedIDs[chain] = next
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// shortAddr turns a long hex/base58 address into a readable label.
func shortAddr(a string) string {
	if len(a) <= 14 {
		return a
	}
	return a[:8] + "…" + a[len(a)-4:]
}

// topNByStake sorts rows by native stake (desc) and keeps n.
func topNByStake(rows []valRow, n int) []valRow {
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].StakeNative > rows[j].StakeNative })
	if n > 0 && len(rows) > n {
		rows = rows[:n]
	}
	return rows
}

// ---- Shared CoinGecko price cache ----------------------------------
//
// The per-chain CoinGecko calls of the original scrapers already burn
// the keyless budget (hundreds of 429s a day on Prom). The new chains
// share ONE batched simple/price call cached for priceTTL, so adding
// eight chains adds at most one request per 10 minutes.

const priceTTL = 10 * time.Minute

var coingeckoBatchIDs = []string{
	"aptos", "near", "kaia", "algorand", "internet-computer",
	"the-open-network", "sei-network", "crypto-com-chain",
	"sui", "cosmos", "cardano", "avalanche-2",
}

var coingeckoBatchURL = envDefault("VAL_ECON_COINGECKO_BATCH_URL",
	"https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids="+strings.Join(coingeckoBatchIDs, ","))

var priceCache = struct {
	sync.Mutex
	at     time.Time
	prices map[string]float64
}{}

// priceUSD returns the cached USD price for a CoinGecko id, refreshing
// the batch when older than priceTTL. 0 means unknown (caller skips
// the stake_usd write); the error is counted under source
// "coingecko_batch" for the calling chain.
func priceUSD(ctx context.Context, client *http.Client, chain, id string) float64 {
	priceCache.Lock()
	defer priceCache.Unlock()
	if priceCache.prices == nil || time.Since(priceCache.at) > priceTTL {
		var payload map[string]map[string]float64
		if err := getJSON(ctx, client, coingeckoBatchURL, &payload); err != nil {
			scrapeErrorsTotal.WithLabelValues(chain, "coingecko_batch").Inc()
			fmt.Printf("[%s] coingecko batch err (stake_usd skipped): %v\n", chain, err)
			// Back off for a full TTL instead of letting every chain
			// retry the same rate-limited call this cycle.
			priceCache.at = time.Now()
		} else {
			m := make(map[string]float64, len(payload))
			for k, v := range payload {
				m[k] = v["usd"]
			}
			priceCache.prices = m
			priceCache.at = time.Now()
		}
	}
	return priceCache.prices[id]
}
