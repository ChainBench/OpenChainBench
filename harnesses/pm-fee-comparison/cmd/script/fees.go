package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"
)

const (
	feesLimitlessBase = "https://api.limitless.exchange"
	feesUA            = "OpenChainBench/1.0 (+https://openchainbench.com/methodology; contact@mobula.io)"
)

var httpClientFees = &http.Client{Timeout: 20 * time.Second}

// setStaticFees publishes known fixed fees once at startup. These are refreshed
// only when the published fee schedules change (manual update required).
func setStaticFees() {
	now := float64(time.Now().Unix())

	// Polymarket: 2% fee deducted from potential payout ($1 resolution).
	// Fee = 2% × $1 = $0.02/contract → 200 bps of $1 gross notional.
	pmFeeTakerBps.WithLabelValues("polymarket").Set(200)
	pmFeeLastRefresh.WithLabelValues("polymarket").Set(now)

	// Kalshi: per-contract fee schedule, approximately $0.07/contract at $0.50 price.
	// $0.07 / $1 resolution value = 7% = 700 bps. Source: kalshi.com published schedule.
	pmFeeTakerBps.WithLabelValues("kalshi").Set(700)
	pmFeeLastRefresh.WithLabelValues("kalshi").Set(now)

	// Manifold: play-money (mana) only, no real-money fee.
	pmFeeTakerBps.WithLabelValues("manifold").Set(0)
	pmFeeLastRefresh.WithLabelValues("manifold").Set(now)

	// Myriad: 2% protocol settlement fee = 200 bps.
	pmFeeTakerBps.WithLabelValues("myriad").Set(200)
	pmFeeLastRefresh.WithLabelValues("myriad").Set(now)

	fmt.Println("[fees] static: polymarket=200 kalshi=700 manifold=0 myriad=200 (bps)")
}

// tradePricesSlice deserializes tradePrices.buy.market / tradePrices.sell.market.
// Each slice element is the price for one outcome (YES=index 0, NO=index 1).
type tradePricesBranch struct {
	Market []float64 `json:"market"`
}

type tradePrices struct {
	Buy  tradePricesBranch `json:"buy"`
	Sell tradePricesBranch `json:"sell"`
}

type limitlessFeeMarket struct {
	Status      string      `json:"status"`
	TradePrices tradePrices `json:"tradePrices"`
	CollateralToken struct {
		Symbol string `json:"symbol"`
	} `json:"collateralToken"`
	WinningOutcomeIndex *int `json:"winningOutcomeIndex"`
}

type limitlessFeeResp struct {
	Data []limitlessFeeMarket `json:"data"`
}

// fetchLimitlessFee polls /markets/active page 1, computes the median
// half-spread in basis points across active USDC binary markets, and sets
// the pm_fee_taker_bps{venue="limitless"} gauge.
//
// Half-spread bps = ((bestAsk - bestBid) / 2) × 10000, where prices are
// expressed as fractions of the $1 resolution value. This is directly
// comparable to Polymarket's 200 bps (2% of $1 payout).
func fetchLimitlessFee() {
	url := fmt.Sprintf("%s/markets/active?page=1&limit=25&sortBy=newest", feesLimitlessBase)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", feesUA)
	req.Header.Set("Accept", "application/json")

	resp, err := httpClientFees.Do(req)
	if err != nil {
		pmFeeFetchErrors.WithLabelValues("limitless", "network").Inc()
		fmt.Printf("[fees][limitless] request error: %v\n", err)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		pmFeeFetchErrors.WithLabelValues("limitless", fmt.Sprintf("http_%d", resp.StatusCode)).Inc()
		fmt.Printf("[fees][limitless] status %d\n", resp.StatusCode)
		return
	}

	var r limitlessFeeResp
	if err := json.Unmarshal(body, &r); err != nil {
		pmFeeFetchErrors.WithLabelValues("limitless", "parse").Inc()
		fmt.Printf("[fees][limitless] parse error: %v\n", err)
		return
	}

	var halfSpreads []float64
	for _, m := range r.Data {
		if m.CollateralToken.Symbol != "USDC" {
			continue
		}
		if m.WinningOutcomeIndex != nil {
			continue
		}
		buy := m.TradePrices.Buy.Market
		sell := m.TradePrices.Sell.Market
		if len(buy) == 0 || len(sell) == 0 {
			continue
		}
		ask := buy[0]
		bid := sell[0]
		// Sanity: bid < ask, both in (0, 1)
		if bid <= 0 || ask <= 0 || bid >= ask || ask > 1 {
			continue
		}
		halfSpreadBps := ((ask - bid) / 2) * 10000
		halfSpreads = append(halfSpreads, halfSpreadBps)
	}

	if len(halfSpreads) == 0 {
		fmt.Printf("[fees][limitless] no valid spread data (markets=%d)\n", len(r.Data))
		return
	}

	sort.Float64s(halfSpreads)
	median := halfSpreads[len(halfSpreads)/2]

	pmFeeTakerBps.WithLabelValues("limitless").Set(median)
	pmFeeLastRefresh.WithLabelValues("limitless").Set(float64(time.Now().Unix()))

	fmt.Printf("[fees][limitless] markets_with_spread=%d median_half_spread_bps=%.1f\n",
		len(halfSpreads), median)
}
