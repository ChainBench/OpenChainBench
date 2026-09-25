package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Chain fees and revenue, from DefiLlama's free per-chain fees overview:
//
//	/overview/fees/<name>?dataType=dailyFees     total24h / total7d / total30d
//	/overview/fees/<name>?dataType=dailyRevenue  same windows, the protocol's cut
//
// "Fees" is what users paid on the chain over the window (gas plus the
// fees of every DefiLlama-tracked protocol on it); "revenue" is the part
// kept by the chain or its protocols rather than passed to LPs and
// stakers. Both windows end on DefiLlama's last complete UTC day. The
// chart is excluded from the request, so a poll costs two small requests
// per chain, once an hour by default: the figures move once a day.
//
// Two ratios join the chain token's market cap to the chain's fee run
// rate, the same P/F and P/S the protocol valuation benches publish: mcap
// over annualized fees, mcap over annualized revenue, annualized = 30-day
// sum x 365/30. Which token is "the chain's" is DefiLlama's own chain to
// gecko_id mapping on /v2/chains (Ethereum ETH, Arbitrum ARB, Hyperliquid
// HYPE; Base, Robinhood Chain and Unichain map to none), and the market cap
// is CoinGecko's circulating figure for that id: one request per tick for
// the whole cohort. Mobula's per-symbol market cap is not used here; it
// resolves HYPE and SEI to the wrong supply (HYPE at $67M on 2026-09-25).
// The ratios publish only when both sides exist and the denominator is
// positive; otherwise the series is deleted rather than written as 0 or
// +Inf.

const feesSource = "fees"

const coingeckoBase = "https://api.coingecko.com/api/v3"

// chainGeckoIDs reads DefiLlama's chain list once and returns chain name ->
// CoinGecko id for the chains that have a token of their own. A chain with
// no gecko_id (Base, Robinhood Chain, Unichain) gets no ratio.
func chainGeckoIDs() (map[string]string, error) {
	body, err := getJSON(httpClientDefillama, defillamaBase+"/v2/chains")
	if err != nil {
		return nil, err
	}
	var arr []struct {
		Name    string  `json:"name"`
		GeckoID *string `json:"gecko_id"`
	}
	if err := json.Unmarshal(body, &arr); err != nil {
		return nil, fmt.Errorf("parse_error: %w", err)
	}
	out := make(map[string]string, len(arr))
	for _, c := range arr {
		if c.GeckoID != nil && *c.GeckoID != "" {
			out[c.Name] = *c.GeckoID
		}
	}
	return out, nil
}

// tokenMcap is CoinGecko's circulating market cap for one id, in USD.
type tokenMcap struct {
	Mcap float64
	FDV  float64
}

// coingeckoMcaps fetches every id in one /coins/markets call (free tier,
// 250 ids per page, one call per tick).
func coingeckoMcaps(ids []string) (map[string]tokenMcap, error) {
	if len(ids) == 0 {
		return map[string]tokenMcap{}, nil
	}
	url := fmt.Sprintf("%s/coins/markets?vs_currency=usd&ids=%s&per_page=250&sparkline=false", coingeckoBase, encodePath(joinIDs(ids)))
	body, err := getJSON(httpClientDefillama, url)
	if err != nil {
		return nil, err
	}
	var arr []struct {
		ID   string   `json:"id"`
		Mcap *float64 `json:"market_cap"`
		FDV  *float64 `json:"fully_diluted_valuation"`
	}
	if err := json.Unmarshal(body, &arr); err != nil {
		return nil, fmt.Errorf("parse_error: %w", err)
	}
	out := make(map[string]tokenMcap, len(arr))
	for _, x := range arr {
		var m tokenMcap
		if x.Mcap != nil {
			m.Mcap = *x.Mcap
		}
		if x.FDV != nil {
			m.FDV = *x.FDV
		}
		out[x.ID] = m
	}
	return out, nil
}

// joinIDs joins CoinGecko ids with commas; encodePath then keeps the
// commas as %2C, which CoinGecko accepts.
func joinIDs(ids []string) string {
	out := ""
	for i, id := range ids {
		if i > 0 {
			out += ","
		}
		out += id
	}
	return out
}

// feeWindows is one dataType's three windows. Pointers keep "DefiLlama
// has no figure" (null) apart from a real zero day.
type feeWindows struct {
	Total24h *float64 `json:"total24h"`
	Total7d  *float64 `json:"total7d"`
	Total30d *float64 `json:"total30d"`
}

// errNotTracked is DefiLlama's definitive "no adapter reports this":
// a 200 with null totals. It is the one error that clears a chain's
// series; transport and parse errors carry the last values forward like
// every other source in this harness.
var errNotTracked = errors.New("not_tracked")

func defillamaFees(chainName, dataType string) (feeWindows, error) {
	url := fmt.Sprintf("%s/overview/fees/%s?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=%s", defillamaBase, encodePath(chainName), dataType)
	body, err := getJSON(httpClientDefillama, url)
	if err != nil {
		return feeWindows{}, err
	}
	var w feeWindows
	if err := json.Unmarshal(body, &w); err != nil {
		return feeWindows{}, fmt.Errorf("parse_error: %w", err)
	}
	if w.Total30d == nil {
		// Moonbeam and Polkadot answer 200 with nulls: the chain is known
		// but no adapter reports fees for it.
		return feeWindows{}, errNotTracked
	}
	return w, nil
}

func fetchAllChainFees() {
	// Market caps first, one DefiLlama call and one CoinGecko call for the
	// whole cohort. A failure here only costs the ratios this tick; the
	// fee gauges still publish.
	mcaps := map[string]tokenMcap{}
	geckoByChain, err := chainGeckoIDs()
	if err != nil {
		chainKpisFetchErrors.WithLabelValues("all", feesSource, classifyError(err.Error())).Inc()
		fmt.Printf("[fees] gecko ids error: %v\n", err)
		geckoByChain = map[string]string{}
	}
	var ids []string
	for _, c := range Registry {
		if id, ok := geckoByChain[c.DefiLlama]; ok && c.DefiLlama != "" {
			ids = append(ids, id)
		}
	}
	if m, err := coingeckoMcaps(ids); err != nil {
		chainKpisFetchErrors.WithLabelValues("all", feesSource, classifyError(err.Error())).Inc()
		fmt.Printf("[fees] coingecko error: %v\n", err)
	} else {
		mcaps = m
	}
	for _, c := range Registry {
		c := c
		if c.DefiLlama == "" {
			continue
		}
		var mc tokenMcap
		if id, ok := geckoByChain[c.DefiLlama]; ok {
			mc = mcaps[id]
		}
		go fetchChainFees(c, mc)
	}
}

func fetchChainFees(c Chain, mc tokenMcap) {
	start := time.Now()
	defer func() {
		chainKpisFetchLatencyMs.WithLabelValues(c.Slug, feesSource).Set(float64(time.Since(start).Milliseconds()))
	}()

	fees, err := defillamaFees(c.DefiLlama, "dailyFees")
	if err != nil {
		chainKpisFetchErrors.WithLabelValues(c.Slug, feesSource, classifyError(err.Error())).Inc()
		chainKpisHealth.WithLabelValues(c.Slug, feesSource).Set(0)
		fmt.Printf("[fees][%s] fees error: %v\n", c.Slug, err)
		if errors.Is(err, errNotTracked) {
			// Definitive answer: the chain has no fees adapter (any more).
			// Clear everything so a chain that lost its adapter stops
			// ranking on the last figure it ever had.
			publishChainFees(c.Slug, chainFeesOut{}, true)
			chainTokenMcapUsd.DeleteLabelValues(c.Slug)
		}
		return
	}
	rev, revErr := defillamaFees(c.DefiLlama, "dailyRevenue")
	// revKnown is false on a transport or parse error on the revenue
	// request alone: the fee side still publishes and the revenue side is
	// left as it was for this hour rather than deleted, so the Revenue,
	// Kept and P/S columns do not blink on one timeout. A not_tracked
	// revenue answer is definitive and clears that side.
	revKnown := true
	if revErr != nil {
		chainKpisFetchErrors.WithLabelValues(c.Slug, feesSource, classifyError(revErr.Error())).Inc()
		fmt.Printf("[fees][%s] revenue error: %v\n", c.Slug, revErr)
		revKnown = errors.Is(revErr, errNotTracked)
	}

	out := computeChainFees(fees, rev, revErr == nil, mc.Mcap, mc.Mcap > 0)
	chainKpisLastRefresh.WithLabelValues(c.Slug, feesSource).Set(float64(time.Now().Unix()))
	chainKpisLastTickUnix.Set(float64(time.Now().Unix()))
	if out.fees30d == nil {
		// No fees over the month (Taiko, Mode on 2026-09-25): the fetch
		// worked but returned no data, so the chain publishes nothing,
		// not even its token's market cap, and does not count as a
		// success.
		publishChainFees(c.Slug, out, true)
		chainTokenMcapUsd.DeleteLabelValues(c.Slug)
		chainKpisHealth.WithLabelValues(c.Slug, feesSource).Set(0)
		return
	}
	if mc.Mcap > 0 {
		chainTokenMcapUsd.WithLabelValues(c.Slug).Set(mc.Mcap)
	} else {
		chainTokenMcapUsd.DeleteLabelValues(c.Slug)
	}
	publishChainFees(c.Slug, out, revKnown)

	chainKpisHealth.WithLabelValues(c.Slug, feesSource).Set(1)
	chainFeesLastSuccessUnix.Set(float64(time.Now().Unix()))
}

// chainFeesOut is what one poll publishes for a chain. A nil pointer
// means "delete the series": the value is unknown or not a division.
type chainFeesOut struct {
	fees24h, fees7d, fees30d *float64
	rev24h, rev7d, rev30d    *float64
	revShare                 *float64
	pf, ps                   *float64
}

func f64(v float64) *float64 { return &v }

// computeChainFees is the pure part of the poll, kept free of I/O so the
// zero and null rules are testable: a chain with no fees over 30 days
// publishes nothing (a $0 row that looks measured is worse than no row),
// a quiet day inside an active month publishes its real zero, and the
// ratios need a positive market cap and a positive denominator.
func computeChainFees(fees, rev feeWindows, haveRev bool, mcap float64, hasMcap bool) chainFeesOut {
	var o chainFeesOut
	if fees.Total30d == nil || *fees.Total30d <= 0 {
		return o
	}
	o.fees30d = fees.Total30d
	o.fees24h = fees.Total24h
	o.fees7d = fees.Total7d
	if haveRev && rev.Total30d != nil {
		o.rev30d = rev.Total30d
		o.rev24h = rev.Total24h
		o.rev7d = rev.Total7d
		o.revShare = f64(100 * *rev.Total30d / *fees.Total30d)
	}
	if hasMcap && mcap > 0 {
		annualFees := *fees.Total30d * 365 / 30
		o.pf = f64(mcap / annualFees)
		if o.rev30d != nil && *o.rev30d > 0 {
			annualRev := *o.rev30d * 365 / 30
			o.ps = f64(mcap / annualRev)
		}
	}
	return o
}

// set writes the gauge when the value is known and deletes the series
// otherwise, so a chain that lost its figure never shows a stale or zero
// one.
func set(g *prometheus.GaugeVec, slug string, v *float64) {
	if v == nil {
		g.DeleteLabelValues(slug)
		return
	}
	g.WithLabelValues(slug).Set(*v)
}

// publishChainFees writes the fee side, and the revenue side (revenue
// windows, share and P/S) only when revKnown: a transient failure on the
// revenue request keeps last hour's revenue gauges rather than deleting
// them.
func publishChainFees(slug string, o chainFeesOut, revKnown bool) {
	set(chainFees24hUsd, slug, o.fees24h)
	set(chainFees7dUsd, slug, o.fees7d)
	set(chainFees30dUsd, slug, o.fees30d)
	set(chainTokenPfRatio, slug, o.pf)
	if !revKnown {
		return
	}
	set(chainRevenue24hUsd, slug, o.rev24h)
	set(chainRevenue7dUsd, slug, o.rev7d)
	set(chainRevenue30dUsd, slug, o.rev30d)
	set(chainRevenueSharePct, slug, o.revShare)
	set(chainTokenPsRatio, slug, o.ps)
}
