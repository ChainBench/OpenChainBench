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

// LeverageTermsSource publishes what a trader actually faces at a chosen
// leverage on a given market: how far price has to move against the position
// before it is liquidated, and how much collateral comes back when it is.
// Four venues, two markets, seven leverage settings.
//
// THE MODEL. Every venue reduces to one number, the maintenance requirement m
// expressed as a share of NOTIONAL, and then:
//
//	room to liquidation = 1/L - m        (a share of price)
//	collateral returned = m * L          (a share of the margin posted)
//
// because a position at leverage L posts 1/L of notional as margin and is
// liquidated when its equity falls to m. The venues differ only in what sets
// m, and that difference is the whole point of the bench:
//
//	dYdX          m = maintenanceMarginFraction, published per market
//	Hyperliquid   m = 1/(2*maxLeverage), the documented halving rule
//	Gains         m = (1 - threshold)/L, so the threshold is a share of
//	              COLLATERAL and the room comes out as threshold/L
//	Papertrade    m = bustBuffer, a fixed share of PRICE
//
// Gains' m shrinks with leverage, which keeps the room proportional to it.
// Papertrade's m does not move at all, so it eats a fixed 5 basis points of
// room at every leverage: negligible at 10x, roughly half the margin at 1000x.
//
// THE PAPERTRADE EXCEPTION. Everywhere else m*L is what the trader gets back.
// On Papertrade it is not: their docs call crossing the bust price a "hard
// bust" which "forfeits the full isolated margin, even if a voluntary close
// immediately beforehand could return some equity". So the returned share is
// published as a real zero, and the m*L a voluntary close would have returned
// is a nuance the bench text carries rather than a column.
//
// Reading that buffer as the room itself, rather than as an offset before the
// zero-equity price, understates the room and is wrong: their own docs work
// the 1000x case and get "a move of about 0.052%", which is 1/1000 minus the
// buffer, not the buffer.
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
	// First four bytes of the keccak-256 of the signature, hardcoded so the
	// harness needs no hashing dependency.
	selPairMaxLev   = "0x281b693c" // pairMaxLeverage(uint256), 1e3
	selPairMinLev   = "0x59a992d0" // pairMinLeverage(uint256), 1e3
	selPairLiqParam = "0x6633ced6" // getPairLiquidationParams(uint256)
	selPairs        = "0xb91ac788" // pairs(uint256), word 9 is the fee index
	selFees         = "0x4acc79ed" // fees(uint256), word 0 is the size fee at 1e10

	leverageTermsUA = "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com"
)

// gainsPairs maps each market to the pair indices Gains offers on it. The two
// are different products, not a ceiling and a floor of one: the standard pair
// runs 1.1x to 200x, and the degen pair has pairMinLeverage equal to
// pairMaxLeverage at 500x, so 500x is its only legal value. A trader who wants
// 50x uses the standard pair; one who wants 500x has only the degen one.
var gainsPairs = map[string][]int64{
	"BTC": {0, 300},
	"ETH": {1, 313},
}

// leverageTermsMarkets are the only two assets all four venues list, which is
// what makes the rows comparable at all.
var leverageTermsMarkets = map[string]bool{"BTC": true, "ETH": true}

// leverageBuckets are the settings the page's selector offers. The label value
// "all" is the venue's OWN maximum rather than a pooled series: the site
// replaces a selector pinned to "all" with the chosen value, so pinning
// bucket="all" in the spec's queries makes the unfiltered page the max-leverage
// view and every other tab a fixed setting shared across venues.
var leverageBuckets = []struct {
	label string
	lev   float64 // 0 means "the venue's maximum"
}{
	{"all", 0},
	{"10x", 10},
	{"25x", 25},
	{"50x", 50},
	{"100x", 100},
	{"500x", 500},
	{"1000x", 1000},
}

// venueTerms is one venue's parameters on one market, reduced to the model
// above. maintenance returns the requirement as a share of notional at the
// given leverage; it takes the leverage because Gains' threshold interpolates
// with it while the other three are flat.
type venueTerms struct {
	venue  string
	market string
	maxLev float64
	// minLev is the lowest leverage the venue will open this market at. It is
	// usually 1 and irrelevant, and on Gains' degen pairs it equals maxLev:
	// pairMinLeverage and pairMaxLeverage both read 500x on pairs 300 and 313,
	// so those are a fixed-leverage product rather than a ceiling, and a row
	// for them on a 10x tab describes a position that cannot be opened.
	minLev float64
	// maintenance is the requirement as a share of notional at that leverage.
	maintenance func(lev float64) float64
	// costPerLeg is the venue's fee as a share of notional, charged on the way
	// in and again on the way out. It sits INSIDE the liquidation trigger: a
	// position pays it out of the same collateral the threshold is measured
	// against, so the price does not have to travel as far. Measured on Gains:
	// 11 liquidations at 500x fired at a 59.4% price loss against an 80%
	// threshold, and 0.02% x 500 x 2 is the 20 point gap.
	costPerLeg float64
	// forfeitsAll: nothing comes back whatever the arithmetic leaves.
	forfeitsAll bool
}

func (s *LeverageTermsSource) Fetch() (*SourceResult, error) {
	// Each venue is independent and publishes its own gauges, so a venue that
	// is down costs its own rows and nothing else. The result is empty on
	// purpose: the router's value map is keyed by (venue, metric) and cannot
	// express a per-market, per-leverage figure, so these gauges are written
	// directly. Nothing here feeds a bench the router serves.
	res := newSourceResult()
	// Clear every series before republishing. A gauge keeps its last value
	// forever, so a venue that lowered its maximum leverage would keep a row
	// on the tabs it no longer offers, at 100% success, contradicting the
	// bench's own rule that a venue below the selected setting is absent.
	perpLeverageMax.Reset()
	perpLiqPriceMovePct.Reset()
	perpLiqCollateralLostPct.Reset()
	perpLiqCollateralKeptPct.Reset()

	var all []venueTerms
	all = append(all, s.fetchGains()...)
	all = append(all, s.fetchPapertrade()...)
	all = append(all, s.fetchHyperliquid()...)
	all = append(all, s.fetchDydx()...)

	// A venue can offer several products on the same market, and Gains does:
	// its standard pair runs 1.1x to 200x while its degen pair is fixed at
	// 500x. Group by (venue, market) so each leverage publishes the product a
	// trader could actually open at it, and where both qualify, the one that
	// leaves more room, which is the choice a trader would make.
	byKey := map[[2]string][]venueTerms{}
	var order [][2]string
	for _, t := range all {
		k := [2]string{t.venue, t.market}
		if _, seen := byKey[k]; !seen {
			order = append(order, k)
		}
		byKey[k] = append(byKey[k], t)
	}
	for _, k := range order {
		publishLeverageTerms(byKey[k])
	}
	return res, nil
}

// publishLeverageTerms writes one venue's gauges on a market, at every leverage
// any of its products allows. A single write path, so the figures are always
// set together: a venue that published a max leverage but no room would read as
// the safest row on the board.
func publishLeverageTerms(variants []venueTerms) {
	if len(variants) == 0 {
		return
	}
	venue, market := variants[0].venue, variants[0].market
	// The venue's ceiling across every product it offers on this market, which
	// is what the max leverage column means.
	ceiling := 0.0
	for _, v := range variants {
		if v.maxLev > ceiling {
			ceiling = v.maxLev
		}
	}

	for _, b := range leverageBuckets {
		best := -1.0
		var bestLost, bestKept float64
		found := false
		for _, v := range variants {
			lev := b.lev
			if lev == 0 {
				// "all" is the venue's own maximum: only the product that
				// reaches the ceiling answers it, so the room sits next to the
				// leverage the max leverage column prints. Gains' standard pair
				// at 200x leaves more room than the degen pair at 500x, and
				// letting it win printed 500x beside the 200x room.
				if v.maxLev != ceiling {
					continue
				}
				lev = v.maxLev
			}
			room, lost, kept, ok := termsAt(v, lev)
			if !ok {
				continue
			}
			if room > best {
				best, bestLost, bestKept, found = room, lost, kept, true
			}
		}
		if !found {
			// No product on this venue can be opened at this leverage. Publish
			// nothing: the bench's rule is that such a venue is absent from the
			// tab rather than shown at a setting it does not offer.
			continue
		}
		perpLeverageMax.WithLabelValues(venue, market, b.label).Set(ceiling)
		perpLiqPriceMovePct.WithLabelValues(venue, market, b.label).Set(best)
		perpLiqCollateralLostPct.WithLabelValues(venue, market, b.label).Set(bestLost)
		perpLiqCollateralKeptPct.WithLabelValues(venue, market, b.label).Set(bestKept)
		if b.label == "all" {
			fmt.Printf("[perp-cohort][%s][%s] %s at max %.0fx: room=%.4f%% lost=%.1f%% kept=%.1f%%\n",
				venue, srcLeverageTerms, market, ceiling, best, bestLost, bestKept)
		}
	}
}

// termsAt is the arithmetic of the model, kept separate from the gauge writes
// so it can be checked against each venue's own worked example.
//
// A position at leverage L posts 1/L of notional and is liquidated when its
// equity reaches the maintenance requirement m. Both fee legs come out of that
// same collateral, so the price has that much less distance to travel:
//
//	room    = 1/L - m - 2*cost          (a share of price)
//	lost    = room * L                  (a share of the collateral)
//	kept    = 1 - lost                  (zero where the venue forfeits all)
//
// Checked against Gains: threshold 80% at 500x with a 0.02% fee gives
// (0.80 - 2*0.0002*500)/500 = 0.1400% of price and 70% of collateral, against a
// measured median of 59.4% of collateral. The remaining gap is the borrowing
// fee, which accrues with holding time and is not a term at open.
func termsAt(t venueTerms, lev float64) (roomPct, lostPct, keptPct float64, ok bool) {
	if lev <= 0 || lev > t.maxLev || (t.minLev > 0 && lev < t.minLev) {
		return 0, 0, 0, false
	}
	m := t.maintenance(lev)
	if m <= 0 {
		return 0, 0, 0, false
	}
	room := (1/lev - m - 2*t.costPerLeg/100) * 100
	if room <= 0 {
		// The fees alone exhaust the margin, so the position cannot be opened
		// at this leverage on these terms. Refuse rather than publish a
		// negative or a zero that would read as "liquidated instantly".
		return 0, 0, 0, false
	}
	lost := room * lev
	if lost <= 0 || lost > 100 {
		return 0, 0, 0, false
	}
	if t.forfeitsAll {
		return room, lost, 0, true
	}
	return room, lost, 100 - lost, true
}

// ---------------------------------------------------------------- Gains

func (s *LeverageTermsSource) fetchGains() []venueTerms {
	var out []venueTerms
	for market, idxs := range gainsPairs {
		for _, idx := range idxs {
			t, ok := s.gainsPair(market, idx)
			if ok {
				out = append(out, t)
			}
		}
	}
	return out
}

// gainsPair reads one pair's terms. A pair that fails any read is skipped
// rather than published with a guessed value: the other pair on the same market
// still publishes, so the venue keeps the leverages it can actually serve.
func (s *LeverageTermsSource) gainsPair(market string, idx int64) (venueTerms, bool) {
	lw, err := s.gainsCall(selPairMaxLev, idx)
	if err != nil || len(lw) < 1 {
		perpCohortFetchErrors.WithLabelValues("gains", srcLeverageTerms, classifyError(fmt.Sprint(err))).Inc()
		fmt.Printf("[perp-cohort][gains][%s] maxLeverage %s pair %d: %v\n", srcLeverageTerms, market, idx, err)
		return venueTerms{}, false
	}
	maxLev := bigToFloat(lw[0], 1e3)
	if maxLev <= 0 {
		return venueTerms{}, false
	}

	// A minimum above 1 is the thing that makes the degen pairs a fixed
	// leverage product. A read failure leaves it at zero, which termsAt treats
	// as "no minimum", so a missing selector degrades to the old behaviour
	// rather than hiding the row.
	var minLev float64
	if mw, err := s.gainsCall(selPairMinLev, idx); err == nil && len(mw) > 0 {
		minLev = bigToFloat(mw[0], 1e3)
	}
	if minLev > maxLev {
		perpCohortFetchErrors.WithLabelValues("gains", srcLeverageTerms, "parse").Inc()
		return venueTerms{}, false
	}

	p, err := s.gainsCall(selPairLiqParam, idx)
	if err != nil || len(p) < 5 {
		perpCohortFetchErrors.WithLabelValues("gains", srcLeverageTerms, "parse").Inc()
		fmt.Printf("[perp-cohort][gains][%s] liqParams %s pair %d: %v\n", srcLeverageTerms, market, idx, err)
		return venueTerms{}, false
	}
	startTh := bigToFloat(p[1], 1e10)
	endTh := bigToFloat(p[2], 1e10)
	startLev := bigToFloat(p[3], 1e3)
	endLev := bigToFloat(p[4], 1e3)
	// A threshold at or past the whole collateral is a decode error, not a
	// term: it would describe a position liquidated before it opens.
	if startTh <= 0 || startTh >= 100 || endTh <= 0 || endTh >= 100 {
		perpCohortFetchErrors.WithLabelValues("gains", srcLeverageTerms, "parse").Inc()
		return venueTerms{}, false
	}

	fee, err := s.gainsPairFee(idx)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("gains", srcLeverageTerms, "parse").Inc()
		fmt.Printf("[perp-cohort][gains][%s] fee %s pair %d: %v\n", srcLeverageTerms, market, idx, err)
		return venueTerms{}, false
	}

	return venueTerms{
		venue:  "gains",
		market: market,
		maxLev: maxLev,
		minLev: minLev,
		// The threshold is a share of collateral, so as a share of notional it
		// is the complement divided by the leverage.
		maintenance: func(lev float64) float64 {
			th := interpolateThreshold(startTh, endTh, startLev, endLev, lev)
			return (100 - th) / 100 / lev
		},
		costPerLeg: fee,
		// Measured, not assumed: amountSentToTrader is 0 on all 27
		// liquidations found across every pair and every leverage from 7.5x to
		// 500x. The threshold says when the position closes, not what comes
		// back, and what comes back is nothing.
		forfeitsAll: true,
	}, true
}

// gainsPairFee reads the pair's position-size fee as a percentage of notional.
//
// pairs(uint256) returns the pair struct; word 9 is its fee index, the same
// offset the perp-fees harness reads in production. fees(uint256) then returns
// the fee group, whose word 0 is the size fee at 1e10 precision: 350_000_000
// is 0.035%, which is the worked example in that harness.
//
// The fee matters here because it sits inside the liquidation trigger. On the
// x500 degen pairs it reads 0.02%, and two legs of it at 500x are 20 points of
// collateral, which is exactly the gap between the 80% threshold and the 59.4%
// median that 11 real liquidations show.
func (s *LeverageTermsSource) gainsPairFee(pairIdx int64) (float64, error) {
	pw, err := s.gainsCall(selPairs, pairIdx)
	if err != nil {
		return 0, err
	}
	if len(pw) < 10 {
		return 0, fmt.Errorf("pairs(%d) returned %d words", pairIdx, len(pw))
	}
	feeIdx := pw[9].Int64()
	fw, err := s.gainsCall(selFees, feeIdx)
	if err != nil {
		return 0, err
	}
	if len(fw) < 1 {
		return 0, fmt.Errorf("fees(%d) returned nothing", feeIdx)
	}
	fee := bigToFloat(fw[0], 1e10)
	// A fee at or above one percent of notional would be an order of magnitude
	// out and would swallow the trigger at high leverage; refuse rather than
	// publish a room computed from a misread scale.
	if fee < 0 || fee > 1 {
		return 0, fmt.Errorf("fee index %d reads %.6f%%, outside a plausible range", feeIdx, fee)
	}
	return fee, nil
}

// interpolateThreshold mirrors getLiqPnlThresholdP in the gTrade contracts: the
// liquidation threshold is flat below startLeverage, flat above endLeverage,
// and linear between the two. A degen pair sets both bounds to the same value,
// which makes the threshold constant.
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
	req, err := http.NewRequest("POST", gainsArbRPC, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
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
	return decodeWordsHex(out.Result)
}

func decodeWordsHex(result string) ([]*big.Int, error) {
	h := strings.TrimPrefix(result, "0x")
	if len(h) < 64 || len(h)%64 != 0 {
		return nil, fmt.Errorf("not a whole number of words: %q", result)
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

// ------------------------------------------------------------ Papertrade

func (s *LeverageTermsSource) fetchPapertrade() []venueTerms {
	req, err := http.NewRequest("GET", "https://exchange.papertrade.xyz/state/trading", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("papertrade", srcLeverageTerms, classifyError(err.Error())).Inc()
		return nil
	}
	defer resp.Body.Close()
	var st struct {
		Instruments [][]json.RawMessage `json:"instruments"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		perpCohortFetchErrors.WithLabelValues("papertrade", srcLeverageTerms, "parse").Inc()
		return nil
	}
	var out []venueTerms
	for _, inst := range st.Instruments {
		symbol, lev, buffer, ok := papertradeTerms(inst)
		if !ok {
			perpCohortFetchErrors.WithLabelValues("papertrade", srcLeverageTerms, "parse").Inc()
			continue
		}
		b := buffer
		out = append(out, venueTerms{
			venue:  "papertrade",
			market: symbol,
			maxLev: lev,
			// Fixed in price, so it does not vary with leverage. That is the
			// whole asymmetry against a collateral-share threshold.
			maintenance: func(float64) float64 { return b },
			// Hard bust: crossing the trigger forfeits the full isolated
			// margin even though a voluntary close a tick earlier would have
			// returned buffer times leverage of it.
			forfeitsAll: true,
		})
	}
	return out
}

// papertradeTerms reads one instrument tuple. The payload is positional, not an
// object: index 1 is the symbol, 14 the max leverage as a plain integer, 16 the
// bust buffer at 1e18 as a decimal string, a share of price. The length guard
// matters more than usual here, because a tuple that grew a field in the middle
// would silently hand back some other number rather than fail.
func papertradeTerms(inst []json.RawMessage) (symbol string, lev, buffer float64, ok bool) {
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
	buffer = bigToFloat(bi, 1e18)
	if buffer <= 0 || buffer >= 1 {
		return "", 0, 0, false
	}
	return symbol, lev, buffer, true
}

// ----------------------------------------------------------- Hyperliquid

// fetchHyperliquid reads maxLeverage per asset from the info `meta` endpoint.
//
// The maintenance requirement is NOT in the payload: Hyperliquid documents it
// as half the initial requirement at maximum leverage, so it is derived rather
// than read. That is a weaker provenance than the other three venues and the
// bench says so in its methodology; it is still the venue's own published rule
// rather than an estimate of ours. It also means the share returned reads 50
// percent at the venue's maximum on every market, by construction.
func (s *LeverageTermsSource) fetchHyperliquid() []venueTerms {
	req, err := http.NewRequest("POST", "https://api.hyperliquid.xyz/info",
		strings.NewReader(`{"type":"meta"}`))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("hyperliquid", srcLeverageTerms, classifyError(err.Error())).Inc()
		return nil
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
		return nil
	}
	var out []venueTerms
	for _, u := range meta.Universe {
		if u.IsDelisted || !leverageTermsMarkets[u.Name] || u.MaxLeverage <= 0 {
			continue
		}
		m := 1 / (2 * u.MaxLeverage)
		out = append(out, venueTerms{
			venue:       "hyperliquid",
			market:      u.Name,
			maxLev:      u.MaxLeverage,
			maintenance: func(float64) float64 { return m },
		})
	}
	return out
}

// ------------------------------------------------------------------ dYdX

// fetchDydx reads initialMarginFraction and maintenanceMarginFraction straight
// off the indexer. Both are published per market, so nothing is derived.
func (s *LeverageTermsSource) fetchDydx() []venueTerms {
	req, err := http.NewRequest("GET", "https://indexer.dydx.trade/v4/perpetualMarkets", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", leverageTermsUA)
	resp, err := s.client.Do(req)
	if err != nil {
		perpCohortFetchErrors.WithLabelValues("dydx", srcLeverageTerms, classifyError(err.Error())).Inc()
		return nil
	}
	defer resp.Body.Close()
	var payload struct {
		Markets map[string]struct {
			Ticker                    string `json:"ticker"`
			Status                    string `json:"status"`
			InitialMarginFraction     string `json:"initialMarginFraction"`
			MaintenanceMarginFraction string `json:"maintenanceMarginFraction"`
		} `json:"markets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		perpCohortFetchErrors.WithLabelValues("dydx", srcLeverageTerms, "parse").Inc()
		return nil
	}
	var out []venueTerms
	for _, mk := range payload.Markets {
		base, _, found := strings.Cut(mk.Ticker, "-")
		if !found || !leverageTermsMarkets[base] || mk.Status != "ACTIVE" {
			continue
		}
		initial, err1 := strconv.ParseFloat(mk.InitialMarginFraction, 64)
		maint, err2 := strconv.ParseFloat(mk.MaintenanceMarginFraction, 64)
		if err1 != nil || err2 != nil || initial <= 0 || maint <= 0 || maint >= initial {
			perpCohortFetchErrors.WithLabelValues("dydx", srcLeverageTerms, "parse").Inc()
			continue
		}
		m := maint
		out = append(out, venueTerms{
			venue:       "dydx",
			market:      base,
			maxLev:      1 / initial,
			maintenance: func(float64) float64 { return m },
		})
	}
	return out
}
