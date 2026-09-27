package main

// source_nado.go — Nado on Ink, the venue the Vertex team runs since Vertex
// wound down on Arbitrum.
//
// Added 2026-09-27 when the cohort was widened. Nado's archive does not
// publish a liquidation tape the way the other venues do; it publishes a
// *cumulative* liquidated-USD counter per product in its hourly market
// snapshots. The 24h figure is therefore the difference between two
// snapshots, one number for the whole window with no per-event detail. That
// is a legitimate reading of the venue, so the row publishes, but the event
// it hands the window carries Aggregate: the largest-single-event gauge would
// otherwise read 100% and claim the day was one position.
//
// One request covers every product: liquidated notional, traded notional and
// open interest all come out of the same snapshot pair.
//
// The raw event feed (event_types liquidate_subaccount) exists as a
// cross-check and agreed to 0.5% on 2026-09-27, but it carries no timestamps,
// only submission_idx, and emits each liquidation twice (once for the
// insurance subaccount 0x..0002 and once for the liquidatee). The counter is
// the cleaner source.

import (
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	nadoArchiveURL = "https://archive.prod.nado.xyz/v1"
	nadoSymbolsURL = "https://gateway.prod.nado.xyz/v1/symbols"
	nadoSymbolsTTL = 30 * time.Minute
	// 25 hourly granules spans a little under 24h; the actual span is read
	// off the snapshot timestamps rather than assumed.
	nadoGranuleCount = 25
	nadoGranularity  = 3600
)

var nadoTrackedAssets = map[string]bool{"ETH": true, "BTC": true, "SOL": true}

// Nado implements Source.
type Nado struct {
	archiveURL string
	symbolsURL string

	mu         sync.Mutex
	productIDs map[string]int // asset -> product_id
	productsAt time.Time
	snapshot   map[string]nadoWindow // asset -> the current 24h window
	snapshotAt time.Time
}

// NewNado returns the Nado source.
func NewNado() *Nado {
	return &Nado{archiveURL: nadoArchiveURL, symbolsURL: nadoSymbolsURL}
}

// HasLiquidationSource reports true — the archive carries a cumulative
// liquidated-USD counter per product.
func (n *Nado) HasLiquidationSource() bool { return true }

// nadoWindow is one asset's 24h deltas plus its current open interest.
type nadoWindow struct {
	liqUSD   float64
	volUSD   float64
	oiUSD    float64
	spanSecs int64
}

type nadoSymbol struct {
	Type      string `json:"type"`
	ProductID int    `json:"product_id"`
	Symbol    string `json:"symbol"`
}

// products resolves asset -> product_id from the gateway catalog. The ids are
// stable (BTC-PERP 2, ETH-PERP 4 on 2026-09-27) but resolving them beats
// hardcoding a number the venue could renumber.
func (n *Nado) products() (map[string]int, error) {
	n.mu.Lock()
	if n.productIDs != nil && time.Since(n.productsAt) < nadoSymbolsTTL {
		p := n.productIDs
		n.mu.Unlock()
		return p, nil
	}
	n.mu.Unlock()

	var symbols []nadoSymbol
	if err := httpGetJSON(n.symbolsURL, &symbols); err != nil {
		return nil, fmt.Errorf("nado symbols: %w", err)
	}
	out := make(map[string]int, 8)
	for _, s := range symbols {
		name := strings.ToUpper(strings.TrimSpace(s.Symbol))
		base, ok := strings.CutSuffix(name, "-PERP")
		if !ok || !nadoTrackedAssets[base] {
			continue
		}
		out[base] = s.ProductID
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("nado symbols: no tracked perp products found")
	}
	n.mu.Lock()
	n.productIDs, n.productsAt = out, time.Now()
	n.mu.Unlock()
	return out, nil
}

type nadoSnapshot struct {
	Timestamp                    flexFloat         `json:"timestamp"`
	CumulativeLiquidationAmounts map[string]string `json:"cumulative_liquidation_amounts"`
	CumulativeVolumes            map[string]string `json:"cumulative_volumes"`
	OpenInterests                map[string]string `json:"open_interests"`
}

// window reads (and caches for one tick interval) the 24h deltas for every
// tracked asset out of a single snapshot pair.
func (n *Nado) window(asset string) (nadoWindow, error) {
	n.mu.Lock()
	if n.snapshot != nil && time.Since(n.snapshotAt) < 2*time.Minute {
		w, ok := n.snapshot[asset]
		n.mu.Unlock()
		if !ok {
			return nadoWindow{}, fmt.Errorf("nado: no snapshot for %s", asset)
		}
		return w, nil
	}
	n.mu.Unlock()

	ids, err := n.products()
	if err != nil {
		return nadoWindow{}, err
	}
	pids := make([]int, 0, len(ids))
	for _, id := range ids {
		pids = append(pids, id)
	}
	payload := map[string]any{
		"market_snapshots": map[string]any{
			"interval": map[string]any{
				"count":       nadoGranuleCount,
				"granularity": nadoGranularity,
			},
			"product_ids": pids,
		},
	}
	var resp struct {
		Snapshots []nadoSnapshot `json:"snapshots"`
	}
	if err := httpPostJSON(n.archiveURL, payload, &resp); err != nil {
		return nadoWindow{}, fmt.Errorf("nado market_snapshots: %w", err)
	}
	if len(resp.Snapshots) < 2 {
		return nadoWindow{}, fmt.Errorf("nado market_snapshots: got %d snapshots, need 2", len(resp.Snapshots))
	}
	// The archive returns newest first; take the ends of what it gave.
	newest, oldest := resp.Snapshots[0], resp.Snapshots[len(resp.Snapshots)-1]
	span := int64(float64(newest.Timestamp) - float64(oldest.Timestamp))
	if span < 0 {
		newest, oldest = oldest, newest
		span = -span
	}
	if span <= 0 {
		return nadoWindow{}, fmt.Errorf("nado market_snapshots: zero span between snapshots")
	}

	out := make(map[string]nadoWindow, len(ids))
	for asset, id := range ids {
		key := strconv.Itoa(id)
		out[asset] = nadoWindow{
			liqUSD:   x18Delta(newest.CumulativeLiquidationAmounts[key], oldest.CumulativeLiquidationAmounts[key]),
			volUSD:   x18Delta(newest.CumulativeVolumes[key], oldest.CumulativeVolumes[key]),
			oiUSD:    x18Value(newest.OpenInterests[key]),
			spanSecs: span,
		}
	}
	n.mu.Lock()
	n.snapshot, n.snapshotAt = out, time.Now()
	n.mu.Unlock()

	w, ok := out[asset]
	if !ok {
		return nadoWindow{}, fmt.Errorf("nado: no snapshot for %s", asset)
	}
	return w, nil
}

// x18Value parses an x18-scaled decimal string to a float.
func x18Value(s string) float64 {
	if strings.TrimSpace(s) == "" {
		return 0
	}
	v, err := parseScaled(s, 18)
	if err != nil {
		return 0
	}
	return v
}

// x18Delta returns (newer - older) for two x18-scaled counters, in big.Int so
// a cumulative-since-launch figure does not lose the delta to float precision.
func x18Delta(newer, older string) float64 {
	a, aok := new(big.Int).SetString(strings.TrimSpace(newer), 10)
	b, bok := new(big.Int).SetString(strings.TrimSpace(older), 10)
	if !aok || !bok {
		return 0
	}
	d := new(big.Int).Sub(a, b)
	if d.Sign() <= 0 {
		return 0
	}
	f := new(big.Float).SetPrec(256).SetInt(d)
	f.Quo(f, new(big.Float).SetPrec(256).SetInt(
		new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)))
	v, _ := f.Float64()
	return v
}

// FetchLiquidationsSince returns the window's liquidated notional as a single
// aggregate entry, restated on every tick.
func (n *Nado) FetchLiquidationsSince(asset string, _ int64) ([]LiqEvent, error) {
	if !nadoTrackedAssets[asset] {
		return nil, fmt.Errorf("nado: unsupported asset %q", asset)
	}
	w, err := n.window(asset)
	if err != nil {
		return nil, err
	}
	if w.liqUSD <= 0 {
		return nil, nil
	}
	return []LiqEvent{{
		Key:         "nado:" + asset + ":window",
		NotionalUSD: w.liqUSD,
		TimestampMs: time.Now().UnixMilli(),
		Bucket:      true,
		Aggregate:   true,
	}}, nil
}

// FetchOI returns the product's open interest, already USD at x18.
func (n *Nado) FetchOI(asset string) (float64, error) {
	if !nadoTrackedAssets[asset] {
		return 0, fmt.Errorf("nado: unsupported asset %q", asset)
	}
	w, err := n.window(asset)
	if err != nil {
		return 0, err
	}
	return w.oiUSD, nil
}

// FetchVolume24hUSD returns the window's traded notional, from the same
// snapshot pair as the numerator.
func (n *Nado) FetchVolume24hUSD(asset string) (float64, error) {
	if !nadoTrackedAssets[asset] {
		return 0, fmt.Errorf("nado: unsupported asset %q", asset)
	}
	w, err := n.window(asset)
	if err != nil {
		return 0, err
	}
	return w.volUSD, nil
}
