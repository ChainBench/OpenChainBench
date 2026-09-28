package main

// source_gains_oi.go: the open-interest denominator, read off the chain
// instead of sampled by the process.
//
// Every other venue here publishes the book it holds now and nothing about
// the book it held this morning, so the harness had to accumulate its own
// readings one tick at a time. That made the denominator a function of how
// long the process had been up, and on 2026-09-28 it made Gains ETH publish
// 952%: the numerator was the whole cascade and the peak was the quiet hour
// after it, 2.72M dollars against a book that had held 43.54M inside the
// same window.
//
// The gTrade diamond does publish its history. PairOiAfterV10Updated fires on
// every open and close and carries the *post-state* open interest per
// collateral, not only the delta, so one pass of the scan this harness
// already makes over the diamond gives the whole curve, sampled at every
// change. Two independent reconstructions, this one and a separate nine-day
// backfill, agree with the venue's own API to the dollar: 2,674,766.
//
// Reconstruction, which has to match FetchOI exactly:
//
//   - keep the latest (long, short) per collateral index, raw
//   - the venue's open interest for a pair is the sum over collateral indices
//     of (long + short) / 10^decimals x collateralPriceUsd
//   - decimals come from trading-variables; the prices come from the
//     execution events where the window has one, so a book from a day when
//     WETH traded elsewhere is valued at that day's price rather than today's
//
// Seeding, which is the part that makes it exact rather than nearly right:
//
//   - a collateral with events inside the window gets its pre-window state
//     from the first of them, by undoing the signed delta on whichever leg
//     w3 says moved
//   - a collateral with no events inside the window has not changed inside
//     the window, so its head value from trading-variables is its value
//     throughout, and no walk-back is needed
//
// Arbitrum runs four collaterals (1 DAI, 2 WETH, 3 USDC, 4 GNS) and all of
// them can hold open interest, so none is special-cased.

import (
	"fmt"
	"log"
	"math/big"
	"sort"
	"strings"
	"time"
)

// PairOiAfterV10Updated, pinned as the literal the chain emits rather than
// recomputed, and asserted against it in a test.
const gainsPairOiTopic = "0x7a50afa193d27f20574d9d7c0bc0100211894a58118f9b152156eea4b1cc9bb7"

// Data words of PairOiAfterV10Updated. collateralIndex and pairIndex are
// indexed, so they arrive as topics rather than words.
const (
	gainsOiWords           = 8
	gainsOiWordDelta       = 0 // oiDeltaCollateral, unsigned magnitude
	gainsOiWordOpen        = 2 // bool: the change grew the book
	gainsOiWordLong        = 3 // bool: which leg moved
	gainsOiWordNewLong     = 4 // newOiCollateral.oiLongCollateral, post-state
	gainsOiWordNewShort    = 5 // newOiCollateral.oiShortCollateral, post-state
	gainsOiTopicCollateral = 1
	gainsOiTopicPair       = 2

	// The head read has to agree with the reconstruction, or one of them is
	// wrong and the denominator is not trustworthy. A percent is slack for
	// the seconds between the two reads.
	gainsOiHeadTolerance = 0.01
)

// gainsOiEvent is one decoded PairOiAfterV10Updated.
type gainsOiEvent struct {
	block           uint64
	tsMs            int64
	collateralIndex uint64
	pairIndex       uint64
	newLong         *big.Int // post-state, raw collateral units
	newShort        *big.Int
	delta           *big.Int // unsigned magnitude of the change
	open            bool
	long            bool
}

// oiReading is the venue's open interest in USD at one instant.
type oiReading struct {
	tsMs int64
	usd  float64
}

// oiHistorySource is implemented by a venue that can read its own past open
// interest rather than only the book it holds now. Such a venue needs no
// warm-up: its peak and mean are right on the first tick.
type oiHistorySource interface {
	FetchOIHistory(asset string, sinceMs int64) ([]oiReading, error)
}

// decodeGainsPairOi decodes one PairOiAfterV10Updated log.
func decodeGainsPairOi(lg ethLog) (gainsOiEvent, error) {
	if len(lg.Topics) <= gainsOiTopicPair {
		return gainsOiEvent{}, fmt.Errorf("oi log has %d topics, expected 3", len(lg.Topics))
	}
	data, err := hexBytes(lg.Data)
	if err != nil {
		return gainsOiEvent{}, fmt.Errorf("data hex: %w", err)
	}
	if len(data) != gainsOiWords*32 {
		return gainsOiEvent{}, fmt.Errorf("oi data has %d bytes, expected %d words", len(data), gainsOiWords)
	}
	word := func(i int) *big.Int { return new(big.Int).SetBytes(data[i*32 : (i+1)*32]) }
	colBytes, err := hexBytes(lg.Topics[gainsOiTopicCollateral])
	if err != nil {
		return gainsOiEvent{}, fmt.Errorf("collateralIndex topic: %w", err)
	}
	pairBytes, err := hexBytes(lg.Topics[gainsOiTopicPair])
	if err != nil {
		return gainsOiEvent{}, fmt.Errorf("pairIndex topic: %w", err)
	}
	blockNum, err := parseHexUint(lg.BlockNumber)
	if err != nil {
		return gainsOiEvent{}, fmt.Errorf("blockNumber: %w", err)
	}
	return gainsOiEvent{
		block:           blockNum,
		collateralIndex: new(big.Int).SetBytes(colBytes).Uint64(),
		pairIndex:       new(big.Int).SetBytes(pairBytes).Uint64(),
		newLong:         word(gainsOiWordNewLong),
		newShort:        word(gainsOiWordNewShort),
		delta:           word(gainsOiWordDelta),
		open:            word(gainsOiWordOpen).Sign() != 0,
		long:            word(gainsOiWordLong).Sign() != 0,
	}, nil
}

// preState undoes the event to give the book as it stood immediately before.
// w0 is an unsigned magnitude and w2 only says which way the book moved, so
// the sign comes from open and the leg from long.
func (e gainsOiEvent) preState() (long, short *big.Int) {
	long, short = new(big.Int).Set(e.newLong), new(big.Int).Set(e.newShort)
	leg := short
	if e.long {
		leg = long
	}
	if e.open {
		leg.Sub(leg, e.delta) // the event grew the book, so it was smaller
	} else {
		leg.Add(leg, e.delta)
	}
	if leg.Sign() < 0 {
		leg.SetInt64(0)
	}
	return long, short
}

// gainsCollateralMeta is what valuing a raw open interest needs. The head
// state is kept as the raw integer the API reports rather than a float: an
// 18-decimal book runs past what a float64 holds exactly, and this value is
// the seed for every reading of a collateral that did not move.
type gainsCollateralMeta struct {
	decimals  int
	headPrice float64
	headLong  *big.Int // trading-variables head state, raw collateral units
	headShort *big.Int
}

// collateralMeta reads decimals, the head price and the head open interest of
// the pair for every collateral of the deployment. The head read is taken
// after the scan, so a collateral with no event in the window is not read at
// an earlier state than the window end.
func (g *Gains) collateralMeta(asset string) (map[uint64]gainsCollateralMeta, error) {
	var tv gainsTV
	if err := httpGetJSON(g.tradingVarsURL, &tv); err != nil {
		return nil, fmt.Errorf("gains trading-variables: %w", err)
	}
	pairIdx := -1
	for i, p := range tv.Pairs {
		if strings.EqualFold(p.From, asset) {
			pairIdx = i
			break
		}
	}
	if pairIdx < 0 {
		return nil, fmt.Errorf("gains: asset %q not found in pairs", asset)
	}
	out := make(map[uint64]gainsCollateralMeta, len(tv.Collaterals))
	for _, col := range tv.Collaterals {
		if col.CollateralIndex == 0 || col.Config.Decimals <= 0 || col.Prices.CollateralPriceUsd <= 0 {
			continue
		}
		m := gainsCollateralMeta{
			decimals:  col.Config.Decimals,
			headPrice: col.Prices.CollateralPriceUsd,
			headLong:  new(big.Int),
			headShort: new(big.Int),
		}
		if pairIdx < len(col.PairOis) {
			if v, ok := new(big.Int).SetString(strings.TrimSpace(col.PairOis[pairIdx].Collateral.OILong), 10); ok {
				m.headLong = v
			}
			if v, ok := new(big.Int).SetString(strings.TrimSpace(col.PairOis[pairIdx].Collateral.OIShort), 10); ok {
				m.headShort = v
			}
		}
		out[col.CollateralIndex] = m
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("gains trading-variables: no usable collaterals")
	}
	return out, nil
}

// priceSeries is the collateral prices the contract stamped on its own
// events, per collateral index, oldest first.
type priceSeries map[uint64][]oiReading

// priceAt returns the stamped price at or before tsMs, or the head price when
// the window holds nothing earlier. Exact for a stablecoin either way; for
// WETH or GNS it stops a book from a day when the collateral traded elsewhere
// being restated at today's price.
func (ps priceSeries) priceAt(collateral uint64, tsMs int64, head float64) float64 {
	pts := ps[collateral]
	if len(pts) == 0 {
		return head
	}
	i := sort.Search(len(pts), func(j int) bool { return pts[j].tsMs > tsMs })
	if i == 0 {
		return head
	}
	if p := pts[i-1].usd; p > 0 {
		return p
	}
	return head
}

// buildPriceSeries collects the stamped prices out of the executions already
// decoded by the scan.
func (g *Gains) buildPriceSeries() priceSeries {
	ps := priceSeries{}
	for _, e := range g.execs {
		if e.collateralIndex == 0 || e.collateralPriceUSD <= 0 || e.tsMs <= 0 {
			continue
		}
		ps[e.collateralIndex] = append(ps[e.collateralIndex], oiReading{tsMs: e.tsMs, usd: e.collateralPriceUSD})
	}
	for k := range ps {
		pts := ps[k]
		sort.Slice(pts, func(i, j int) bool { return pts[i].tsMs < pts[j].tsMs })
		ps[k] = pts
	}
	return ps
}

// FetchOIHistory reconstructs the pair's open interest in USD at every change
// from sinceMs to the head of the scan.
func (g *Gains) FetchOIHistory(asset string, sinceMs int64) ([]oiReading, error) {
	pairIdx, ok := gainsPairIndex[asset]
	if !ok {
		return nil, fmt.Errorf("gains: unsupported asset %q", asset)
	}
	if err := g.scan(); err != nil {
		return nil, err
	}
	meta, err := g.collateralMeta(asset)
	if err != nil {
		return nil, err
	}

	g.mu.Lock()
	events := make([]gainsOiEvent, 0, 64)
	for _, e := range g.oiEvents {
		if e.pairIndex == pairIdx && e.tsMs >= sinceMs {
			events = append(events, e)
		}
	}
	prices := g.buildPriceSeries()
	g.mu.Unlock()

	sort.Slice(events, func(i, j int) bool {
		if events[i].block != events[j].block {
			return events[i].block < events[j].block
		}
		return events[i].collateralIndex < events[j].collateralIndex
	})

	// The state each collateral held when the window opened.
	type legs struct{ long, short *big.Int }
	state := make(map[uint64]*legs, len(meta))
	firstSeen := make(map[uint64]bool, len(meta))
	for _, e := range events {
		if firstSeen[e.collateralIndex] {
			continue
		}
		firstSeen[e.collateralIndex] = true
		l, sh := e.preState()
		state[e.collateralIndex] = &legs{long: l, short: sh}
	}
	for ci, m := range meta {
		if firstSeen[ci] {
			continue
		}
		// No event inside the window means no change inside the window, so
		// the head state is the state throughout. It is already raw, so it
		// needs no scaling, only copying.
		state[ci] = &legs{
			long:  new(big.Int).Set(m.headLong),
			short: new(big.Int).Set(m.headShort),
		}
	}

	value := func(tsMs int64) float64 {
		total := 0.0
		for ci, lg := range state {
			m, ok := meta[ci]
			if !ok {
				continue
			}
			sum := new(big.Float).SetInt(new(big.Int).Add(lg.long, lg.short))
			sum.Quo(sum, big.NewFloat(pow10(m.decimals)))
			units, _ := sum.Float64()
			total += units * prices.priceAt(ci, tsMs, m.headPrice)
		}
		return total
	}

	out := make([]oiReading, 0, len(events)+1)
	out = append(out, oiReading{tsMs: sinceMs, usd: value(sinceMs)})
	for _, e := range events {
		lg, ok := state[e.collateralIndex]
		if !ok {
			lg = &legs{long: new(big.Int), short: new(big.Int)}
			state[e.collateralIndex] = lg
		}
		lg.long, lg.short = new(big.Int).Set(e.newLong), new(big.Int).Set(e.newShort)
		out = append(out, oiReading{tsMs: e.tsMs, usd: value(e.tsMs)})
	}
	return out, nil
}

// pow10 is 10^n as a float, for the decimal scales involved here (6 to 18).
func pow10(n int) float64 {
	v := 1.0
	for i := 0; i < n; i++ {
		v *= 10
	}
	return v
}

// FetchOIHistory sums the deployments at every point either of them moved,
// each chain holding its last known value in between.
func (m *GainsMulti) FetchOIHistory(asset string, sinceMs int64) ([]oiReading, error) {
	series := make([][]oiReading, 0, len(m.chains))
	for _, c := range m.chains {
		s, err := c.FetchOIHistory(asset, sinceMs)
		if err != nil {
			return nil, fmt.Errorf("gains/%s: %w", c.chain, err)
		}
		if len(s) > 0 {
			series = append(series, s)
		}
	}
	return mergeOISeries(series, sinceMs), nil
}

// mergeOISeries steps every series over the union of their timestamps and
// sums the last known value of each, so two deployments with different event
// times add up correctly rather than interleaving.
func mergeOISeries(series [][]oiReading, sinceMs int64) []oiReading {
	if len(series) == 0 {
		return nil
	}
	if len(series) == 1 {
		return series[0]
	}
	stamps := map[int64]bool{sinceMs: true}
	for _, s := range series {
		for _, r := range s {
			stamps[r.tsMs] = true
		}
	}
	all := make([]int64, 0, len(stamps))
	for t := range stamps {
		all = append(all, t)
	}
	sort.Slice(all, func(i, j int) bool { return all[i] < all[j] })

	idx := make([]int, len(series))
	last := make([]float64, len(series))
	out := make([]oiReading, 0, len(all))
	for _, t := range all {
		for i, s := range series {
			for idx[i] < len(s) && s[idx[i]].tsMs <= t {
				last[i] = s[idx[i]].usd
				idx[i]++
			}
		}
		total := 0.0
		for _, v := range last {
			total += v
		}
		out = append(out, oiReading{tsMs: t, usd: total})
	}
	return out
}

// checkOIHead compares the reconstruction's head against the venue's own
// current figure. Agreement is what makes the series trustworthy, and it is
// one cheap read, so it runs every tick and says so in the log.
// Returns the gap as a fraction and whether it is inside the tolerance, so
// the check is assertable without reading the collectors back.
func checkOIHead(venue, asset string, history []oiReading, head float64) (float64, bool) {
	if len(history) == 0 || head <= 0 {
		return 0, false
	}
	recon := history[len(history)-1].usd
	gap := (recon - head) / head
	if gap < 0 {
		gap = -gap
	}
	if gap > gainsOiHeadTolerance {
		log.Printf("[%s/%s] open-interest reconstruction disagrees with the venue: %.2f from %d readings against %.2f live, %.2f%% apart",
			venue, asset, recon, len(history), head, gap*100)
		recordFetchError(venue, asset, "oi_head_mismatch")
		return gap, false
	}
	log.Printf("[%s/%s] open interest reconstructed from %d readings: head %.2f against %.2f live, %.3f%% apart",
		venue, asset, len(history), recon, head, gap*100)
	return gap, true
}

// oiHistoryAge is how far back a history read asks. The numerator covers the
// window, so the denominator has to as well, and the scan's own buffer is
// pruned to the window plus the fetch overlap anyway.
func oiHistorySince(now time.Time) int64 {
	return now.Add(-windowSpan).UnixMilli()
}
