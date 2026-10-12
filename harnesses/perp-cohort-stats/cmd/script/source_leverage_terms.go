package main

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// LeverageTermsSource publishes what a trader actually faces at a venue's
// maximum leverage on a given market: how far price has to move against the
// position before it is liquidated, and how much collateral comes back when it
// is. Two venues offer four-figure leverage on crypto and the headline numbers
// look alike, so the terms behind them are the comparison worth publishing.
//
// Only BTC and ETH are covered, because they are the only markets both venues
// list. Papertrade has exactly two instruments; Gains carries the same two
// assets in its 500x "degen" cohort as separate markets from its main BTC/USD
// and ETH/USD, which cap at 200x.
//
// GAINS, read from the Arbitrum diamond with eth_call:
//
//	pairMaxLeverage(uint256)          0x281b693c  (1e3)
//	getPairLiquidationParams(uint256) 0x6633ced6  (maxLiqSpreadP,
//	                                   startLiqThresholdP, endLiqThresholdP
//	                                   at 1e10, startLeverage, endLeverage
//	                                   at 1e3)
//
// Selectors are the first four bytes of the keccak-256 of the signature,
// hardcoded so the harness needs no hashing dependency. The threshold is a
// share of COLLATERAL and interpolates with leverage, so the price move is the
// threshold divided by the leverage. Gains liquidates at a loss of that
// threshold, which means the remainder is returned.
//
// PAPERTRADE, read from /state/trading. Each instrument is a positional tuple:
// index 14 is max leverage as a plain integer, index 16 is the bust buffer in
// 1e18 fixed point. The buffer is a share of PRICE and does not vary with
// leverage, so the price move is the buffer itself at any leverage, and
// crossing it forfeits the whole margin.
//
// The asymmetry this exposes: because Papertrade's buffer is fixed in price,
// its effective maintenance margin is buffer times leverage, which reaches
// roughly half the collateral at 1000x while Gains still returns a fifth.
type LeverageTermsSource struct {
	client *http.Client
}

func NewLeverageTermsSource() *LeverageTermsSource {
	return &LeverageTermsSource{client: &http.Client{Timeout: 25 * time.Second}}
}

func (s *LeverageTermsSource) Name() string { return srcLeverageTerms }

const (
	gainsArbRPC     = "https://arbitrum-one-rpc.publicnode.com"
	gainsDiamondArb = "0xFF162c694eAA571f685030649814282eA457f169"
	selPairMaxLev   = "0x281b693c"
	selPairLiqParam = "0x6633ced6"
)

// gainsDegenPairs maps the market label to its pair index on the diamond.
var gainsDegenPairs = map[string]int64{"BTC": 300, "ETH": 313}

// leverageTermsMarkets are the only two assets all four venues list, which is
// what makes the rows comparable at all.
var leverageTermsMarkets = map[string]bool{"BTC": true, "ETH": true}

const leverageTermsUA = "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com"

func (s *LeverageTermsSource) Fetch() (*SourceResult, error) {
	// Each venue is independent and each publishes its own gauges, so a
	// venue that is down costs its own rows and nothing else. The result is
	// empty on purpose: see the type comment on why these do not go through
	// the router's per-venue value map.
	res := newSourceResult()
	s.fetchGains()
	s.fetchPapertrade()
	s.fetchHyperliquid()
	s.fetchDydx()
	return res, nil
}

func (s *LeverageTermsSource) fetchGains() {
	for market, idx := range gainsDegenPairs {
		lev, err := s.gainsCall(selPairMaxLev, idx)
		if err != nil {
			perpCohortFetchErrors.WithLabelValues("gains", srcLeverageTerms, classifyError(err.Error())).Inc()
			fmt.Printf("[perp-cohort][gains][%s] maxLeverage %s: %v\n", srcLeverageTerms, market, err)
			continue
		}
		if len(lev) < 1 || lev[0] == nil {
			continue
		}
		maxLev := new(big.Float).Quo(new(big.Float).SetInt(lev[0]), big.NewFloat(1e3))
		ml, _ := maxLev.Float64()
		if ml <= 0 {
			continue
		}

		p, err := s.gainsCall(selPairLiqParam, idx)
		if err != nil || len(p) < 5 {
			perpCohortFetchErrors.WithLabelValues("gains", srcLeverageTerms, "parse").Inc()
			fmt.Printf("[perp-cohort][gains][%s] liqParams %s: %v\n", srcLeverageTerms, market, err)
			continue
		}
		move, kept, ok := gainsTerms(p, ml)
		if !ok {
			continue
		}
		publishLeverageTerms("gains", market, ml, move, kept)
	}
}

// gainsTerms turns a decoded getPairLiquidationParams return into the two
// published numbers. The threshold is a percentage of COLLATERAL, so dividing
// it by the leverage converts it into the percentage of PRICE that reaches it,
// and whatever the threshold leaves behind is what the trader gets back.
func gainsTerms(words []*big.Int, maxLev float64) (movePct, keptPct float64, ok bool) {
	if len(words) < 5 || maxLev <= 0 {
		return 0, 0, false
	}
	th := interpolateThreshold(
		bigToFloat(words[1], 1e10), // startLiqThresholdP
		bigToFloat(words[2], 1e10), // endLiqThresholdP
		bigToFloat(words[3], 1e3),  // startLeverage
		bigToFloat(words[4], 1e3),  // endLeverage
		maxLev,
	)
	// A threshold at or past 100 % of collateral would mean the position is
	// already liquidated at open, which is a decode error rather than a term.
	if th <= 0 || th >= 100 {
		return 0, 0, false
	}
	return th / maxLev, 100 - th, true
}

// interpolateThreshold mirrors getLiqPnlThresholdP in the gTrade contracts: the
// liquidation threshold is flat below startLeverage, flat above endLeverage,
// and linear between the two. A degen pair sets both bounds to the same value,
// which makes the threshold constant at that leverage.
func interpolateThreshold(startTh, endTh, startLev, endLev, lev float64) float64 {
	if lev <= startLev {
		return startTh
	}
	if lev >= endLev {
		return endTh
	}
	return startTh - ((lev-startLev)*(startTh-endTh))/(endLev-startLev)
}

func bigToFloat(i *big.Int, scale float64) float64 {
	if i == nil {
		return 0
	}
	f, _ := new(big.Float).Quo(new(big.Float).SetInt(i), big.NewFloat(scale)).Float64()
	return f
}

func (s *LeverageTermsSource) gainsCall(selector string, arg int64) ([]*big.Int, error) {
	data := fmt.Sprintf("%s%064x", selector, arg)
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "eth_call",
		"params": []any{map[string]string{"to": gainsDiamondArb, "data": data}, "latest"},
	})
	req, _ := http.NewRequest("POST", gainsArbRPC, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Result string `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("rpc: %s", out.Error.Message)
	}
	h := strings.TrimPrefix(out.Result, "0x")
	if len(h) < 64 {
		return nil, fmt.Errorf("short result %q", out.Result)
	}
	var words []*big.Int
	for i := 0; i+64 <= len(h); i += 64 {
		v, ok := new(big.Int).SetString(h[i:i+64], 16)
		if !ok {
			return nil, fmt.Errorf("bad word at %d", i)
		}
		words = append(words, v)
	}
	return words, nil
}

func (s *LeverageTermsSource) fetchPapertrade() {
	req, _ := http.NewRequest("GET", "https://exchange.papertrade.xyz/state/trading", nil)
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("papertrade", srcLeverageTerms, classifyError(err.Error())).Inc()
		return
	}
	defer resp.Body.Close()
	var st struct {
		Instruments [][]json.RawMessage `json:"instruments"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		perpCohortFetchErrors.WithLabelValues("papertrade", srcLeverageTerms, "parse").Inc()
		return
	}
	for _, inst := range st.Instruments {
		symbol, lev, move, ok := papertradeTerms(inst)
		if !ok {
			perpCohortFetchErrors.WithLabelValues("papertrade", srcLeverageTerms, "parse").Inc()
			continue
		}
		// Crossing the bust price forfeits the whole margin, so nothing comes
		// back. Published as an explicit zero rather than left absent: the
		// absence of a number and a zero mean very different things here, and
		// the bench sets zero_is_a_value so the row is not pruned.
		publishLeverageTerms("papertrade", symbol, lev, move, 0)
	}
}

// papertradeTerms reads one instrument tuple. The payload is positional, not
// an object: index 1 is the symbol, 14 the max leverage as a plain integer, 16
// the bust buffer at 1e18 as a decimal string. The length guard matters more
// than usual here, because a tuple that grew a field in the middle would
// silently hand back some other number rather than fail.
func papertradeTerms(inst []json.RawMessage) (symbol string, lev, movePct float64, ok bool) {
	if len(inst) < 17 {
		return "", 0, 0, false
	}
	if err := json.Unmarshal(inst[1], &symbol); err != nil || symbol == "" {
		return "", 0, 0, false
	}
	if err := json.Unmarshal(inst[14], &lev); err != nil || lev <= 0 {
		return "", 0, 0, false
	}
	var bufRaw string
	if err := json.Unmarshal(inst[16], &bufRaw); err != nil {
		return "", 0, 0, false
	}
	bi, okBuf := new(big.Int).SetString(bufRaw, 10)
	if !okBuf {
		return "", 0, 0, false
	}
	// The buffer is a fraction of price in 1e18 fixed point, so x100 is the
	// percentage move. It does NOT scale with leverage: that is the whole
	// asymmetry against a collateral-share threshold.
	movePct = bigToFloat(bi, 1e18) * 100
	if movePct <= 0 {
		return "", 0, 0, false
	}
	return symbol, lev, movePct, true
}

// marginTerms converts an initial and a maintenance margin requirement, both
// expressed as a share of NOTIONAL, into the two published numbers.
//
// A position opened at maximum leverage posts exactly the initial requirement.
// It is liquidated when equity falls to the maintenance requirement, so the
// loss it can absorb is the gap between the two, and that loss as a share of
// price is the same gap divided by nothing: both are already shares of
// notional, and price moves notional one for one. What comes back is the
// maintenance requirement itself, as a share of the collateral posted.
func marginTerms(initialFrac, maintenanceFrac float64) (maxLev, movePct, keptPct float64, ok bool) {
	if initialFrac <= 0 || maintenanceFrac <= 0 || maintenanceFrac >= initialFrac {
		return 0, 0, 0, false
	}
	return 1 / initialFrac,
		(initialFrac - maintenanceFrac) * 100,
		maintenanceFrac / initialFrac * 100,
		true
}

// fetchHyperliquid reads maxLeverage per asset from the info `meta` endpoint.
//
// The maintenance requirement is NOT in the payload: Hyperliquid documents it
// as half the initial requirement at maximum leverage, so it is derived rather
// than read. That is a weaker provenance than the other three venues and the
// bench says so in its methodology; it is still the venue's own published rule
// rather than an estimate of ours.
func (s *LeverageTermsSource) fetchHyperliquid() {
	body := strings.NewReader(`{"type":"meta"}`)
	req, err := http.NewRequest("POST", "https://api.hyperliquid.xyz/info", body)
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("hyperliquid", srcLeverageTerms, classifyError(err.Error())).Inc()
		return
	}
	defer resp.Body.Close()
	var meta struct {
		Universe []struct {
			Name        string  `json:"name"`
			MaxLeverage float64 `json:"maxLeverage"`
			IsDelisted  bool    `json:"isDelisted"`
		} `json:"universe"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		perpCohortFetchErrors.WithLabelValues("hyperliquid", srcLeverageTerms, "parse").Inc()
		return
	}
	for _, u := range meta.Universe {
		if u.IsDelisted || !leverageTermsMarkets[u.Name] || u.MaxLeverage <= 0 {
			continue
		}
		initial := 1 / u.MaxLeverage
		// Documented as half the initial requirement at max leverage.
		maxLev, move, kept, ok := marginTerms(initial, initial/2)
		if !ok {
			continue
		}
		publishLeverageTerms("hyperliquid", u.Name, maxLev, move, kept)
	}
}

// fetchDydx reads initialMarginFraction and maintenanceMarginFraction straight
// off the indexer. Both are published per market, so nothing is derived.
func (s *LeverageTermsSource) fetchDydx() {
	req, err := http.NewRequest("GET", "https://indexer.dydx.trade/v4/perpetualMarkets", nil)
	if err != nil {
		return
	}
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("dydx", srcLeverageTerms, classifyError(err.Error())).Inc()
		return
	}
	defer resp.Body.Close()
	var out struct {
		Markets map[string]struct {
			Ticker                    string `json:"ticker"`
			Status                    string `json:"status"`
			InitialMarginFraction     string `json:"initialMarginFraction"`
			MaintenanceMarginFraction string `json:"maintenanceMarginFraction"`
		} `json:"markets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		perpCohortFetchErrors.WithLabelValues("dydx", srcLeverageTerms, "parse").Inc()
		return
	}
	for _, m := range out.Markets {
		base, _, found := strings.Cut(m.Ticker, "-")
		if !found || !leverageTermsMarkets[base] || m.Status != "ACTIVE" {
			continue
		}
		initial, err1 := strconv.ParseFloat(m.InitialMarginFraction, 64)
		maint, err2 := strconv.ParseFloat(m.MaintenanceMarginFraction, 64)
		if err1 != nil || err2 != nil {
			perpCohortFetchErrors.WithLabelValues("dydx", srcLeverageTerms, "parse").Inc()
			continue
		}
		maxLev, move, kept, ok := marginTerms(initial, maint)
		if !ok {
			continue
		}
		publishLeverageTerms("dydx", base, maxLev, move, kept)
	}
}

// publishLeverageTerms is the single write path, so every venue's three gauges
// are set together or not at all. A venue that published a max leverage but no
// survivable move would read as the safest venue on the board.
func publishLeverageTerms(venue, market string, maxLev, movePct, keptPct float64) {
	perpLeverageMax.WithLabelValues(venue, market).Set(maxLev)
	perpLiqPriceMovePct.WithLabelValues(venue, market).Set(movePct)
	perpLiqCollateralKeptPct.WithLabelValues(venue, market).Set(keptPct)
	fmt.Printf("[perp-cohort][%s][%s] %s: maxLev=%.0fx move=%.4f%% kept=%.1f%%\n",
		venue, srcLeverageTerms, market, maxLev, movePct, keptPct)
}
