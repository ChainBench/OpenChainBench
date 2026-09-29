package main

// source_ostium.go: Ostium on Arbitrum.
//
// Added 2026-09-27 when the cohort was widened. Ostium has no REST surface
// (api.ostium.io and metadata.ostium.io do not resolve); the Ormi-hosted
// subgraph the cohort harness already reads is the only data path.
//
// Liquidations come from tradeEvents whose type is the LiquidationExecuted
// enum value. Two things about that entity matter:
//
//   - tradeEvents.notional is null on a liquidation row. The size has to be
//     read from the linked trade, whose notional is 6-decimal USD.
//   - the subgraph's own boolean filters on orders do not behave (a where
//     clause on isCancelled returns no rows at all), so orders are fetched
//     and filtered here.
//
// Ostium is small: $418k of executed notional in the 24h to 2026-09-27, and
// no liquidation at all in that window on any pair, the most recent being
// 40 hours old. Over 7 days the same query returns 99 events including
// $159,564 on ETH and $167,905 on BTC, so the path is live and the 24h zero
// is the venue rather than the query. A zero does not rank on this bench.

import (
	"fmt"
	"strings"
	"time"
)

// The same subgraph URL harnesses/perp-cohort-stats reads.
const (
	ostiumSubgraphURL = "https://api.subgraph.ormilabs.com/api/public/67a599d5-c8d2-4cc4-9c4d-2975a97bc5d8/subgraphs/ost-prod/live/gn"
	ostiumPageLimit   = 200
	ostiumMaxPages    = 10
)

var ostiumTrackedAssets = map[string]bool{"ETH": true, "BTC": true, "SOL": true}

// Ostium implements Source.
type Ostium struct {
	subgraphURL string
}

// NewOstium returns the Ostium source.
func NewOstium() *Ostium { return &Ostium{subgraphURL: ostiumSubgraphURL} }

// HasLiquidationSource reports true: the subgraph carries a
// LiquidationExecuted event type.
func (o *Ostium) HasLiquidationSource() bool { return true }

// ostiumQuery posts a GraphQL query and decodes data into out.
func (o *Ostium) ostiumQuery(query string, out any) error {
	var resp struct {
		Data   any `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	resp.Data = out
	if err := httpPostJSON(o.subgraphURL, map[string]any{"query": query}, &resp); err != nil {
		return fmt.Errorf("ostium subgraph: %w", err)
	}
	if len(resp.Errors) > 0 {
		return fmt.Errorf("ostium subgraph: %s", resp.Errors[0].Message)
	}
	return nil
}

// ostiumLiqRow is one LiquidationExecuted row. The forfeited-collateral
// quantities come partly off the event and partly off the linked trade, because
// the event's own collateralDelta, leverage and notional are all null on a
// liquidation (checked on 91 rows over the 7 days to 2026-09-29):
//
//   - trade.collateral is the margin, 6-decimal USD.
//   - trade.leverage is 1e2 fixed point, not 1e3: a row reading 7500 is 75x,
//     and trade.notional / trade.collateral comes out at 75.00 on that row.
//   - profitPercent is the price return at 1e6 fixed point, negative on a loss.
//     Verified against (closePrice - openPrice) / openPrice x leverage on 91 of
//     91 rows.
//   - amountSentToTrader is 6-decimal USD and read zero on all 91. Confirmed
//     against the chain: in 0xfa67b49b the two USDC transfers out of the
//     trading storage total 1,516.844 against a collateral of 1,516.842, and
//     both go to the vault.
type ostiumLiqRow struct {
	ID             string `json:"id"`
	Timestamp      string `json:"timestamp"`          // unix seconds, as a string
	ProfitPercent  string `json:"profitPercent"`      // 1e6 fixed point percent, signed
	AmountSentToTr string `json:"amountSentToTrader"` // 6-decimal USD
	Pair           struct {
		From string `json:"from"`
	} `json:"pair"`
	Trade struct {
		Notional   string `json:"notional"`   // 6-decimal USD
		Collateral string `json:"collateral"` // 6-decimal USD
		Leverage   string `json:"leverage"`   // 1e2 fixed point
	} `json:"trade"`
}

// ostiumLeverageScale is the divisor on trade.leverage. Ostium writes 7500 for
// 75x, unlike Gains which writes 75000 for the same leverage.
const ostiumLeverageScale = 2

// FetchLiquidationsSince returns executed liquidations of the asset since
// sinceMs.
func (o *Ostium) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	if !ostiumTrackedAssets[asset] {
		return nil, fmt.Errorf("ostium: unsupported asset %q", asset)
	}
	want := strings.ToUpper(asset)
	var events []LiqEvent
	oldestReadMs := int64(0)
	for page := 0; page < ostiumMaxPages; page++ {
		q := fmt.Sprintf(
			`{ tradeEvents(first:%d, skip:%d, orderBy:timestamp, orderDirection:desc, `+
				`where:{type:LiquidationExecuted, timestamp_gte:"%d"}) `+
				`{ id timestamp profitPercent amountSentToTrader pair { from } `+
				`trade { notional collateral leverage } } }`,
			ostiumPageLimit, page*ostiumPageLimit, sinceMs/1000)
		var out struct {
			TradeEvents []ostiumLiqRow `json:"tradeEvents"`
		}
		if err := o.ostiumQuery(q, &out); err != nil {
			return nil, err
		}
		for _, r := range out.TradeEvents {
			sec, err := parseF(r.Timestamp)
			if err != nil || sec <= 0 {
				continue
			}
			if ms := int64(sec) * 1000; oldestReadMs == 0 || ms < oldestReadMs {
				oldestReadMs = ms
			}
			if !strings.EqualFold(r.Pair.From, want) {
				continue
			}
			usd, err := parseScaled(r.Trade.Notional, 6)
			if err != nil || usd <= 0 {
				continue
			}
			e := LiqEvent{
				Key:         "ostium:" + r.ID,
				NotionalUSD: usd,
				TimestampMs: int64(sec) * 1000,
			}
			// The position behind the close, where the linked trade carries it.
			// A row missing the collateral publishes its notional and stays out
			// of the forfeited arithmetic rather than entering it as a zero.
			col, cerr := parseScaled(r.Trade.Collateral, 6)
			if cerr == nil && col > 0 {
				// The margin and the leverage stand on the linked trade alone
				// and feed two gauges older than this one, so they are not
				// coupled to the two fields below: a row whose
				// amountSentToTrader arrives null would otherwise drop out of
				// perp_liq_collateral_24h_usd as well.
				e.CollateralUSD = col
				if lev, lerr := parseScaled(r.Trade.Leverage, ostiumLeverageScale); lerr == nil && lev > 0 {
					e.Leverage = lev
				}
				pct, perr := parseScaled(r.ProfitPercent, 6)
				sent, serr := parseScaled(r.AmountSentToTr, 6)
				if perr == nil && serr == nil && pct <= 0 {
					e.HasForfeitDetail = true
					e.LossAtTriggerPct = -pct
					e.ReturnedUSD = sent
				}
			}
			events = append(events, e)
		}
		if len(out.TradeEvents) < ostiumPageLimit {
			return events, nil
		}
	}
	// Ordered by timestamp desc, so the unread part is the oldest; the rows
	// go back with the edge.
	return events, &partialWindowError{OldestReadMs: oldestReadMs, Cap: ostiumMaxPages * ostiumPageLimit, What: "ostium tradeEvents"}
}

type ostiumPair struct {
	From        string `json:"from"`
	LongOI      string `json:"longOI"`         // base units, 1e18
	ShortOI     string `json:"shortOI"`        // base units, 1e18
	LastTradePr string `json:"lastTradePrice"` // USD, 1e18
}

// FetchOI returns (longOI + shortOI) x lastTradePrice for the asset's pair.
func (o *Ostium) FetchOI(asset string) (float64, error) {
	if !ostiumTrackedAssets[asset] {
		return 0, fmt.Errorf("ostium: unsupported asset %q", asset)
	}
	var out struct {
		Pairs []ostiumPair `json:"pairs"`
	}
	if err := o.ostiumQuery(
		`{ pairs(first:200) { from longOI shortOI lastTradePrice } }`, &out); err != nil {
		return 0, err
	}
	for _, p := range out.Pairs {
		if !strings.EqualFold(p.From, asset) {
			continue
		}
		long, err := parseScaled(p.LongOI, 18)
		if err != nil {
			return 0, fmt.Errorf("ostium longOI: %w", err)
		}
		short, err := parseScaled(p.ShortOI, 18)
		if err != nil {
			return 0, fmt.Errorf("ostium shortOI: %w", err)
		}
		px, err := parseScaled(p.LastTradePr, 18)
		if err != nil {
			return 0, fmt.Errorf("ostium lastTradePrice: %w", err)
		}
		if px <= 0 {
			return 0, fmt.Errorf("ostium: lastTradePrice is zero for %s", asset)
		}
		return poolOpenInterest(long, short) * px, nil
	}
	return 0, fmt.Errorf("ostium: pair %q not found", asset)
}

type ostiumOrder struct {
	ID          string `json:"id"`
	Notional    string `json:"notional"` // 6-decimal USD
	IsCancelled bool   `json:"isCancelled"`
	IsFailed    bool   `json:"isFailed"`
	Pair        struct {
		From string `json:"from"`
	} `json:"pair"`
}

// FetchVolume24hUSD sums executed order notional for the asset over 24h.
// Cancelled and failed orders are filtered here rather than in the where
// clause, which returns nothing when a boolean is named. Rows are
// deduplicated by id because skip paging over a live, newest-first list
// repeats the tail of the previous page, and hitting the page cap is an
// error rather than a partial denominator for the rank gate.
func (o *Ostium) FetchVolume24hUSD(asset string) (float64, error) {
	if !ostiumTrackedAssets[asset] {
		return 0, fmt.Errorf("ostium: unsupported asset %q", asset)
	}
	since := time.Now().Add(-windowSpan).Unix()
	total := 0.0
	seen := make(map[string]bool, 256)
	for page := 0; page < ostiumMaxPages; page++ {
		q := fmt.Sprintf(
			`{ orders(first:%d, skip:%d, orderBy:executedAt, orderDirection:desc, `+
				`where:{executedAt_gte:"%d"}) `+
				`{ id notional isCancelled isFailed pair { from } } }`,
			ostiumPageLimit, page*ostiumPageLimit, since)
		var out struct {
			Orders []ostiumOrder `json:"orders"`
		}
		if err := o.ostiumQuery(q, &out); err != nil {
			return 0, err
		}
		for _, r := range out.Orders {
			if r.ID != "" {
				if seen[r.ID] {
					continue
				}
				seen[r.ID] = true
			}
			if r.IsCancelled || r.IsFailed || !strings.EqualFold(r.Pair.From, asset) {
				continue
			}
			usd, err := parseScaled(r.Notional, 6)
			if err != nil || usd <= 0 {
				continue
			}
			total += usd
		}
		if len(out.Orders) < ostiumPageLimit {
			return total, nil
		}
	}
	return 0, fmt.Errorf("ostium: more than %d orders in 24h; refusing a partial sum", ostiumMaxPages*ostiumPageLimit)
}

// CarriesPositionDetail reports true: the subgraph's liquidation row carries
// profitPercent and amountSentToTrader, and the linked trade carries the
// collateral and the leverage.
func (o *Ostium) CarriesPositionDetail() bool { return true }
