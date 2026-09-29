package main

// source_gmx.go: GMX v2 on Arbitrum.
//
// OI: GET arbitrum-api.gmxinfra.io/markets/info: sums openInterestLong +
// openInterestShort across all isListed markets whose name matches the asset
// (e.g. "ETH/USD [ETH-USDC]" + "ETH/USD [ETH-ETH]" for ETH). Values are
// 30-decimal USD strings; divided by 1e30 to get USD.
//
// Liquidations: from the public Subsquid squid the cohort harness already
// reads, which does expose the order type. This spec claimed until
// 2026-09-27 that no source existed because "Subsquid positionChanges does
// not expose an orderType or isLiquidation flag". That is true of
// positionChanges and false of tradeActions, whose orderType is 7 for a
// liquidation. Re-checked on 2026-09-27: 103 executed liquidations in 24h
// across every market, $900,656 of notional, of which ETH $276,827 and BTC
// $145,148. There is no REST liquidation endpoint on gmxinfra (/liquidations,
// /actions, /trades all 404), so the squid is the only path.
//
// Every liquidation appears in tradeActions twice, once as OrderCreated and
// once as OrderExecuted, so eventName has to be pinned or the figure doubles.

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	gmxMarketsInfoURL = "https://arbitrum-api.gmxinfra.io/markets/info"
	gmxMarketsTTL     = 4 * time.Minute
	// The squid the cohort harness reads (harnesses/perp-cohort-stats).
	gmxSquidURL = "https://gmx.squids.live/gmx-synthetics-arbitrum/graphql"
	// Order.OrderType: 7 is Liquidation. 2 and above are the position
	// orders, so orderType_gte 2 is the venue's own executed notional and
	// excludes the plain swap types 0 and 1.
	gmxOrderTypeLiquidation = 7
	gmxOrderTypeFirstPos    = 2
	gmxSquidPageLimit       = 500
	gmxSquidMaxPages        = 20
	// The 24h volume query pages over a few thousand rows, so it is re-read
	// on a timer rather than on every 5-minute tick.
	gmxVolumeTTL = 15 * time.Minute
	// A failure is remembered only long enough for the other asset of the
	// same tick to reuse it, not for the success TTL. Caching a transient
	// error for fifteen minutes is how one momentary empty market list took
	// both GMX rows out for three ticks on 2026-09-28.
	gmxVolumeErrTTL = 60 * time.Second
	// The same rule for the market list: a failure is held only long enough
	// for the other asset of the tick to reuse it.
	gmxMarketsErrTTL = 60 * time.Second
)

// Attempts at the market list before an empty answer is believed. Vars so a
// test can drive the path without paying the wait.
var (
	gmxMarketsAttempts  = 3
	gmxMarketsRetryBase = 500 * time.Millisecond
)

// gmxTrackedAssets lists the assets supported by this source.
var gmxTrackedAssets = map[string]bool{"ETH": true, "BTC": true}

// GMX implements Source with a small cached /markets/info snapshot.
type GMX struct {
	marketsURL string // defaults to gmxMarketsInfoURL
	squidURL   string // defaults to gmxSquidURL

	mu         sync.Mutex
	markets    []gmxMarket
	marketsErr error // the last failure, held for gmxMarketsErrTTL
	marketsAt  time.Time
	// volMu is held across the whole volume refresh, so the ETH and BTC
	// goroutines that miss the cache on the same tick page the squid once
	// between them rather than once each.
	volMu    sync.Mutex
	volume   map[string]float64
	volErr   error // the last refresh's failure, cached for the same TTL
	volumeAt time.Time
}

// NewGMX returns the GMX source.
func NewGMX() *GMX {
	return &GMX{marketsURL: gmxMarketsInfoURL, squidURL: gmxSquidURL}
}

type gmxMarket struct {
	Name              string `json:"name"`
	MarketToken       string `json:"marketToken"`
	IsListed          bool   `json:"isListed"`
	OpenInterestLong  string `json:"openInterestLong"`  // 30-decimal USD
	OpenInterestShort string `json:"openInterestShort"` // 30-decimal USD
}

func (g *GMX) fetchMarkets() ([]gmxMarket, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.markets != nil && time.Since(g.marketsAt) < gmxMarketsTTL {
		return g.markets, nil
	}
	if g.marketsErr != nil && time.Since(g.marketsAt) < gmxMarketsErrTTL {
		return nil, g.marketsErr
	}
	// An empty list is a 200 with nothing in it, so the HTTP retry does not
	// see it. It happens, and a venue whose market list came back empty for
	// a moment must not read as a venue with no liquidations, so ask again
	// before believing it.
	var resp struct {
		Markets []gmxMarket `json:"markets"`
	}
	// Only the empty 200 is retried here. A transport error or a 5xx has
	// already been retried inside doRaw, and retrying it again on top of that
	// held this lock for minutes: two GMX goroutines need the market list, so
	// a hanging endpoint used to stall every other venue's tick behind them.
	var lastErr error
	for attempt := 0; attempt < gmxMarketsAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * gmxMarketsRetryBase)
		}
		resp.Markets = nil
		if err := httpGetJSON(g.marketsURL, &resp); err != nil {
			lastErr = fmt.Errorf("gmx markets: %w", err)
			break
		}
		if len(resp.Markets) == 0 {
			lastErr = fmt.Errorf("gmx markets: empty market list")
			continue
		}
		lastErr = nil
		break
	}
	if lastErr != nil {
		// Remember the failure for about a tick, so the second asset of this
		// tick does not pay for it again.
		g.marketsErr, g.marketsAt = lastErr, time.Now()
		return nil, lastErr
	}
	g.marketsErr = nil
	g.markets = resp.Markets
	g.marketsAt = time.Now()
	return g.markets, nil
}

// gmxAssetMatches reports whether the asset appears as the leading token of
// the market name (before the first "/" or space), preventing "WETH/..." from
// matching "ETH" while still matching "ETH/USD [WETH-USDC]" and similar.
func gmxAssetMatches(marketName, asset string) bool {
	upper := strings.ToUpper(strings.TrimSpace(marketName))
	a := strings.ToUpper(asset)
	return upper == a ||
		strings.HasPrefix(upper, a+"/") ||
		strings.HasPrefix(upper, a+" ") ||
		strings.HasPrefix(upper, a+"-")
}

// HasLiquidationSource reports true: the squid's tradeActions carries the
// order type, and 7 is a liquidation.
func (g *GMX) HasLiquidationSource() bool { return true }

// gmxTradeAction is one row of the squid's tradeActions.
//
// The last four fields are what makes GMX the one order-executed feed in this
// cohort that can answer the forfeited-collateral question:
//
//   - initialCollateralDeltaAmount on a liquidation row is the position's whole
//     margin at the close, in the collateral token's own units.
//   - collateralTokenPriceMin prices it. GMX quotes a price per smallest unit
//     at 1e30, so collateral in USD is amount x price / 1e30 with no decimals
//     lookup at all, which is why this source needs no token metadata.
//   - basePnlUsd is the price profit and loss, before fees and price impact,
//     at 30 decimals. The loss at trigger.
//   - pnlUsd is the same figure all in: base P&L plus impact minus every fee
//     (position fee, liquidation fee, borrowing, funding). collateral + pnlUsd
//     is the residual paid out, verified against the chain.
type gmxTradeAction struct {
	MarketAddress   string `json:"marketAddress"`
	SizeDeltaUsd    string `json:"sizeDeltaUsd"` // 30-decimal USD
	Timestamp       int64  `json:"timestamp"`    // unix seconds
	TransactionHash string `json:"transactionHash"`
	OrderKey        string `json:"orderKey"`

	InitialCollateralDeltaAmount string `json:"initialCollateralDeltaAmount"` // collateral token units
	CollateralTokenPriceMin      string `json:"collateralTokenPriceMin"`      // USD per unit, 1e30
	BasePnlUsd                   string `json:"basePnlUsd"`                   // 30-decimal USD, signed
	PnlUsd                       string `json:"pnlUsd"`                       // 30-decimal USD, signed
}

// gmxCollateralUSD prices a liquidation row's margin. GMX's collateralTokenPrice
// is USD per smallest unit scaled by 1e30, so amount x price / 1e30 is USD for
// every token without knowing its decimals: 39,512,118 units of USDC at
// 999971002500000000000000 is 39.5110 dollars.
func gmxCollateralUSD(amount, priceMin string) (float64, error) {
	if amount == "" || priceMin == "" {
		return 0, fmt.Errorf("gmx: liquidation row carries no collateral amount or price")
	}
	a, ok := new(big.Float).SetPrec(256).SetString(amount)
	if !ok {
		return 0, fmt.Errorf("gmx: bad collateral amount %q", amount)
	}
	p, ok := new(big.Float).SetPrec(256).SetString(priceMin)
	if !ok {
		return 0, fmt.Errorf("gmx: bad collateral price %q", priceMin)
	}
	v, _ := new(big.Float).Quo(new(big.Float).Mul(a, p), big.NewFloat(1e30)).Float64()
	return v, nil
}

// gmxSigned30 parses one of the squid's signed 30-decimal USD strings.
func gmxSigned30(s string) (float64, error) {
	if s == "" {
		return 0, fmt.Errorf("gmx: empty signed usd figure")
	}
	f, ok := new(big.Float).SetPrec(256).SetString(s)
	if !ok {
		return 0, fmt.Errorf("gmx: bad signed usd figure %q", s)
	}
	v, _ := new(big.Float).Quo(f, big.NewFloat(1e30)).Float64()
	return v, nil
}

// gmxFieldsSize is the selection the volume sum needs, and gmxFieldsPosition
// the wider one the liquidation numerator needs. They are separate because the
// volume query pages over a few thousand rows and the squid refuses a response
// it estimates to be too large ("response might exceed the size limit"): asking
// every executed order of a busy day for four more BigInt fields it has no use
// for is how that refusal would arrive, and a refused volume read unranks both
// GMX rows.
const (
	gmxFieldsSize     = "marketAddress sizeDeltaUsd timestamp transactionHash orderKey"
	gmxFieldsPosition = gmxFieldsSize +
		" initialCollateralDeltaAmount collateralTokenPriceMin basePnlUsd pnlUsd"
)

// squidTradeActions pages tradeActions under one where clause. Rows are
// deduplicated by orderKey: the squid is live and ordered newest first, so a
// row inserted between two pages shifts the next page down and repeats the
// tail of the previous one. Hitting the page cap hands back the rows read
// with a partialWindowError naming the oldest of them; the liquidation
// caller folds those in and holds the rank, the volume caller refuses the
// partial sum because it feeds the rank gate's denominator.
func (g *GMX) squidTradeActions(where, fields string) ([]gmxTradeAction, error) {
	var all []gmxTradeAction
	seen := make(map[string]bool, 1024)
	oldestRead := int64(0)
	page := 0
	for ; page < gmxSquidMaxPages; page++ {
		q := fmt.Sprintf(
			`{ tradeActions(where:{%s}, orderBy:timestamp_DESC, limit:%d, offset:%d) `+
				`{ %s } }`,
			where, gmxSquidPageLimit, page*gmxSquidPageLimit, fields)
		var resp struct {
			Data struct {
				TradeActions []gmxTradeAction `json:"tradeActions"`
			} `json:"data"`
			Errors []struct {
				Message string `json:"message"`
			} `json:"errors"`
		}
		if err := httpPostJSON(g.squidURL, map[string]any{"query": q}, &resp); err != nil {
			return nil, fmt.Errorf("gmx squid: %w", err)
		}
		if len(resp.Errors) > 0 {
			return nil, fmt.Errorf("gmx squid: %s", resp.Errors[0].Message)
		}
		for _, r := range resp.Data.TradeActions {
			id := r.OrderKey
			if id == "" {
				id = r.TransactionHash + ":" + r.MarketAddress + ":" + fmt.Sprint(r.Timestamp)
			}
			if seen[id] {
				continue
			}
			seen[id] = true
			all = append(all, r)
			if oldestRead == 0 || r.Timestamp < oldestRead {
				oldestRead = r.Timestamp
			}
		}
		if len(resp.Data.TradeActions) < gmxSquidPageLimit {
			return all, nil
		}
	}
	return all, &partialWindowError{OldestReadMs: oldestRead * 1000, Cap: gmxSquidMaxPages * gmxSquidPageLimit, What: "gmx squid tradeActions"}
}

// marketAsset maps a market token address to the asset it trades. The index
// token comes first in the market name, so "XRP/USD [ETH-USDC]" is an XRP
// market collateralised in ETH and must not be read as ETH.
func (g *GMX) marketAsset() (map[string]string, error) {
	markets, err := g.fetchMarkets()
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(markets))
	for _, m := range markets {
		out[strings.ToLower(m.MarketToken)] = gmxIndexToken(m.Name)
	}
	return out, nil
}

// trackedMarketTokens returns the market token addresses of the assets this
// source publishes, in the casing the markets endpoint reports them, which is
// the casing the squid stores.
func (g *GMX) trackedMarketTokens() ([]string, error) {
	markets, err := g.fetchMarkets()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, 8)
	for _, m := range markets {
		if gmxTrackedAssets[gmxIndexToken(m.Name)] {
			out = append(out, m.MarketToken)
		}
	}
	return out, nil
}

// gmxIndexToken is the index token of a market name: the part before the
// first separator, under the same rule gmxAssetMatches applies for OI, so the
// numerator, the denominator and the open interest cover one market set.
func gmxIndexToken(marketName string) string {
	name := strings.ToUpper(strings.TrimSpace(marketName))
	if i := strings.IndexAny(name, "/ -"); i > 0 {
		name = name[:i]
	}
	return name
}

// FetchLiquidationsSince returns executed liquidations of the asset since
// sinceMs. sizeDeltaUsd is already USD at execution, at 30 decimals, so no
// price lookup is needed.
func (g *GMX) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	if !gmxTrackedAssets[asset] {
		return nil, fmt.Errorf("gmx: unsupported asset %q", asset)
	}
	byMarket, err := g.marketAsset()
	if err != nil {
		return nil, err
	}
	where := fmt.Sprintf(`orderType_eq:%d, eventName_eq:"OrderExecuted", timestamp_gte:%d`,
		gmxOrderTypeLiquidation, sinceMs/1000)
	rows, err := g.squidTradeActions(where, gmxFieldsPosition)
	var partial *partialWindowError
	if err != nil && !errors.As(err, &partial) {
		return nil, err
	}
	want := strings.ToUpper(asset)
	var events []LiqEvent
	for _, r := range rows {
		if byMarket[strings.ToLower(r.MarketAddress)] != want {
			continue
		}
		usd, err := parseScaled(r.SizeDeltaUsd, 30)
		if err != nil || usd <= 0 {
			continue
		}
		key := r.OrderKey
		if key == "" {
			key = fmt.Sprintf("%s:%s:%d", r.TransactionHash, r.MarketAddress, r.Timestamp)
		}
		e := LiqEvent{
			Key:         "gmx:" + key,
			NotionalUSD: usd,
			TimestampMs: r.Timestamp * 1000,
		}
		// The position behind the fill, where the row carries it. A squid row
		// with no collateral figure publishes its notional and stays out of
		// the forfeited arithmetic rather than entering it as a zero.
		if col, cerr := gmxCollateralUSD(r.InitialCollateralDeltaAmount, r.CollateralTokenPriceMin); cerr == nil && col > 0 {
			// The margin and the leverage stand on the collateral figure alone,
			// and they feed two gauges older than this one. Coupling them to the
			// P&L reads below would have made perp_liq_collateral_24h_usd and
			// perp_liq_median_leverage_x mean one thing on Gains, which sets
			// them unconditionally, and another on GMX.
			e.CollateralUSD = col
			e.Leverage = usd / col
			base, berr := gmxSigned30(r.BasePnlUsd)
			allIn, aerr := gmxSigned30(r.PnlUsd)
			if berr == nil && aerr == nil && base <= 0 {
				e.HasForfeitDetail = true
				e.LossAtTriggerPct = -base / col * 100
				// What is left after the price loss, the impact and every fee
				// is paid back out of the pool. Verified against the chain:
				// in 0xee583c74 the residual computed here, 8.6551 USDC, is
				// the 8.655363 USDC the pool transferred to the liquidated
				// account in that same transaction.
				if resid := col + allIn; resid > 0 {
					e.ReturnedUSD = resid
				}
			}
		}
		events = append(events, e)
	}
	// err is nil or the partialWindowError, which travels with the rows.
	return events, err
}

// FetchVolume24hUSD returns the asset's executed position notional over the
// trailing 24h, summed from the same squid the numerator comes from, so the
// plausibility test compares two figures with one definition behind them.
// Cached for gmxVolumeTTL because the query pages over a few thousand rows.
func (g *GMX) FetchVolume24hUSD(asset string) (float64, error) {
	if !gmxTrackedAssets[asset] {
		return 0, fmt.Errorf("gmx: unsupported asset %q", asset)
	}
	g.volMu.Lock()
	defer g.volMu.Unlock()
	if g.volume != nil && time.Since(g.volumeAt) < gmxVolumeTTL {
		return g.volume[strings.ToUpper(asset)], nil
	}
	// A failed read is cached for the same TTL as a good one. Without this
	// the ETH goroutine and then the BTC goroutine each paged the squid to
	// the cap on every tick, since only success wrote the cache.
	if g.volErr != nil && time.Since(g.volumeAt) < gmxVolumeErrTTL {
		return 0, g.volErr
	}

	byMarket, err := g.marketAsset()
	if err != nil {
		g.volume, g.volErr, g.volumeAt = nil, err, time.Now()
		return 0, err
	}
	// Only the tracked markets. Asking for every market's executed orders
	// put a normal day (a few thousand rows) a small multiple under the
	// 10,000-row cap, so a busy day refused the sum and unranked GMX, on
	// exactly the days this bench is about.
	//
	// Both spellings of each address go into the filter. marketAddress_in is
	// an exact string match and the two sources disagree on case: the squid
	// stores EIP-55 checksummed addresses and this map is keyed lowercase.
	// Sending only the lowercase form matched nothing, which silently left
	// both GMX rows with no volume denominator at all.
	tracked, terr := g.trackedMarketTokens()
	if terr != nil {
		g.volume, g.volErr, g.volumeAt = nil, terr, time.Now()
		return 0, terr
	}
	markets := make([]string, 0, 16)
	for _, token := range tracked {
		markets = append(markets, `"`+token+`"`)
		if lower := strings.ToLower(token); lower != token {
			markets = append(markets, `"`+lower+`"`)
		}
	}
	if len(markets) == 0 {
		return 0, fmt.Errorf("gmx: no market tokens resolved for the tracked assets")
	}
	sort.Strings(markets) // stable query text, so the squid can cache it
	since := time.Now().Add(-windowSpan).Unix()
	where := fmt.Sprintf(`orderType_gte:%d, eventName_eq:"OrderExecuted", timestamp_gte:%d, marketAddress_in:[%s]`,
		gmxOrderTypeFirstPos, since, strings.Join(markets, ","))
	rows, err := g.squidTradeActions(where, gmxFieldsSize)
	if err != nil {
		// Including a page-cap refusal: a partial sum must not become the
		// rank gate's denominator, so the row goes unranked for the tick.
		g.volume, g.volErr, g.volumeAt = nil, err, time.Now()
		return 0, err
	}
	totals := make(map[string]float64, 8)
	for _, r := range rows {
		a := byMarket[strings.ToLower(r.MarketAddress)]
		if a == "" {
			continue
		}
		usd, err := parseScaled(r.SizeDeltaUsd, 30)
		if err != nil || usd <= 0 {
			continue
		}
		totals[a] += usd
	}
	g.volume, g.volErr, g.volumeAt = totals, nil, time.Now()
	return totals[strings.ToUpper(asset)], nil
}

// FetchOI sums openInterestLong + openInterestShort across all listed markets
// that match the asset, converting from 30-decimal fixed-point USD to float64.
func (g *GMX) FetchOI(asset string) (float64, error) {
	if !gmxTrackedAssets[asset] {
		return 0, fmt.Errorf("gmx: unsupported asset %q", asset)
	}
	markets, err := g.fetchMarkets()
	if err != nil {
		return 0, err
	}

	var long, short float64
	matched := false
	for _, m := range markets {
		if !m.IsListed || !gmxAssetMatches(m.Name, asset) {
			continue
		}
		matched = true
		if m.OpenInterestLong != "" {
			v, err := parseScaled(m.OpenInterestLong, 30)
			if err == nil {
				long += v
			}
		}
		if m.OpenInterestShort != "" {
			v, err := parseScaled(m.OpenInterestShort, 30)
			if err == nil {
				short += v
			}
		}
	}
	if !matched {
		return 0, fmt.Errorf("gmx: no listed markets found for %q", asset)
	}
	return poolOpenInterest(long, short), nil
}

// CarriesPositionDetail reports true: the squid's liquidation row carries
// initialCollateralDeltaAmount, basePnlUsd and pnlUsd, so this venue can answer
// the forfeited-collateral question.
func (g *GMX) CarriesPositionDetail() bool { return true }
