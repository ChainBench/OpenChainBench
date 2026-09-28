package main

// source_gains_oi_test.go: the open-interest reconstruction, pinned against a
// real PairOiAfterV10Updated log and against two independent nine-day
// backfills of the venue.
//
// Both backfills agreed with the venue's own API to the dollar, which is what
// makes the daily figures below usable as expected values rather than as
// anecdotes: ETH head 2,674,766 against 2,674,766 live from 2,223 events, and
// BTC head 10,654,440 against 10,654,440 live from 2,310 events with all four
// collateral indices appearing.
//
// The numbers that matter for this bench, measured over 2026-09-28:
//
//	         peak         trough       harness read before      published
//	ETH      43,542,097    2,632,738    2,720,929 (post-crash)   952%
//	BTC      49,942,261    1,124,257   10,790,000 (post-crash)   211%
//
// With the real peak, ETH's 27.29M of liquidations is about 63% of the book
// and BTC's 12.26M about 25%. The old denominator understated BTC by 4.6x.

import (
	"math"
	"testing"
	"time"
)

func TestGainsOiTopic_MatchesTheDiamond(t *testing.T) {
	const want = "0x7a50afa193d27f20574d9d7c0bc0100211894a58118f9b152156eea4b1cc9bb7"
	if gainsPairOiTopic != want {
		t.Fatalf("PairOiAfterV10Updated topic = %s, want %s", gainsPairOiTopic, want)
	}
}

// A real log: USDC (collateral 3) on ETH (pair 1), Arbitrum block 509712946.
// The post-state it carries, 1,037,588.524109 long and 1,575,489.090311 short
// at 6 decimals, is the same state trading-variables reported for that
// collateral at the time, which is how the reconstruction was validated.
func goldenGainsOiLog() ethLog {
	return ethLog{
		Address: gainsArbitrumDiamond,
		Topics: []string{
			gainsPairOiTopic,
			"0x0000000000000000000000000000000000000000000000000000000000000003",
			"0x0000000000000000000000000000000000000000000000000000000000000001",
		},
		Data: gainsWords(
			"000000000000000000000000000000000000000000000000000000004b1a1300", // w0 oiDeltaCollateral 1,260 USDC
			"0000000000000000000000000000000000000000000000000682925ed7d8cb44", // w1 oiDeltaToken
			"0000000000000000000000000000000000000000000000000000000000000001", // w2 open = true
			"0000000000000000000000000000000000000000000000000000000000000001", // w3 long = true
			"000000000000000000000000000000000000000000000000000000f195186c4d", // w4 newOiLongCollateral
			"0000000000000000000000000000000000000000000000000000016ed277b307", // w5 newOiShortCollateral
			"00000000000000000000000000000000000000000000001556f95763a1ecc2f4", // w6 newOiLongToken
			"000000000000000000000000000000000000000000000020b95a77275022b46c", // w7 newOiShortToken
		),
		BlockNumber: "0x1e619a32",
		TxHash:      "0x74cd3dffcd24a5461009d908f5fb12b425b78633ecd1c5f5fdab1cfb6cda43f1",
		LogIndex:    "0xc",
	}
}

func TestDecodeGainsPairOi_GoldenLog(t *testing.T) {
	ev, err := decodeGainsPairOi(goldenGainsOiLog())
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if ev.collateralIndex != 3 || ev.pairIndex != 1 {
		t.Fatalf("collateral=%d pair=%d, want 3 and 1", ev.collateralIndex, ev.pairIndex)
	}
	if !ev.open || !ev.long {
		t.Fatalf("open=%v long=%v, want both true", ev.open, ev.long)
	}
	if got := ev.newLong.String(); got != "1037588524109" {
		t.Fatalf("newLong = %s, want 1037588524109", got)
	}
	if got := ev.newShort.String(); got != "1575489090311" {
		t.Fatalf("newShort = %s, want 1575489090311", got)
	}
	if got := ev.delta.String(); got != "1260000000" {
		t.Fatalf("delta = %s, want 1260000000", got)
	}
	if ev.block != 509712946 {
		t.Fatalf("block = %d", ev.block)
	}

	// The book immediately before: the event grew the long leg by its delta,
	// so undoing it subtracts from long and leaves short alone.
	preLong, preShort := ev.preState()
	if got := preLong.String(); got != "1036328524109" {
		t.Fatalf("preLong = %s, want 1036328524109", got)
	}
	if got := preShort.String(); got != "1575489090311" {
		t.Fatalf("preShort = %s, want the short leg untouched", got)
	}
}

// Closing shrinks the book, so undoing a close adds the delta back. And the
// leg that moved is the one w3 names, never both.
func TestGainsOiPreState_Directions(t *testing.T) {
	lg := goldenGainsOiLog()
	lg.Data = replaceWord(lg.Data, gainsOiWordOpen, zeroWord) // a close
	ev, err := decodeGainsPairOi(lg)
	if err != nil {
		t.Fatal(err)
	}
	preLong, preShort := ev.preState()
	if got := preLong.String(); got != "1038848524109" { // +1,260 USDC
		t.Fatalf("preLong on a close = %s, want 1038848524109", got)
	}
	if got := preShort.String(); got != "1575489090311" {
		t.Fatalf("preShort moved on a long event: %s", got)
	}

	lg = goldenGainsOiLog()
	lg.Data = replaceWord(lg.Data, gainsOiWordLong, zeroWord) // a short opened
	ev, err = decodeGainsPairOi(lg)
	if err != nil {
		t.Fatal(err)
	}
	preLong, preShort = ev.preState()
	if got := preLong.String(); got != "1037588524109" {
		t.Fatalf("preLong moved on a short event: %s", got)
	}
	if got := preShort.String(); got != "1574229090311" { // -1,260 USDC
		t.Fatalf("preShort on a short open = %s, want 1574229090311", got)
	}
}

func TestDecodeGainsPairOi_Refusals(t *testing.T) {
	lg := goldenGainsOiLog()
	lg.Data += zeroWord
	if _, err := decodeGainsPairOi(lg); err == nil {
		t.Error("a 9-word oi log decoded cleanly")
	}
	lg = goldenGainsOiLog()
	lg.Topics = lg.Topics[:2]
	if _, err := decodeGainsPairOi(lg); err == nil {
		t.Error("an oi log with no pair topic decoded cleanly")
	}
}

// The whole reconstruction: a collateral with an event inside the window is
// seeded from that event's pre-state, and a collateral with no event is held
// at its head value because it cannot have changed.
func TestGainsFetchOIHistory_SeedsBothKinds(t *testing.T) {
	// USDC (3, 6dp, $1) moves inside the window; WETH (2, 18dp, $2,000) does
	// not, and holds 1 long and 1 short throughout.
	collaterals := []map[string]any{
		gainsCollateral(3, "USDC", 6, 1.0, []map[string]any{
			gainsPairOI("0", "0"), gainsPairOI("2000000000", "1000000000")}),
		gainsCollateral(2, "WETH", 18, 2000, []map[string]any{
			gainsPairOI("0", "0"), gainsPairOI("1000000000000000000", "1000000000000000000")}),
	}
	tv := tvServer(t, tradingVarsBody(btcEthPairs, collaterals))
	defer tv.Close()

	// One event: USDC long grew by 500 to 2,000, short 1,000.
	oiLog := map[string]any{
		"address": gainsArbitrumDiamond,
		"topics": []string{gainsPairOiTopic,
			"0x0000000000000000000000000000000000000000000000000000000000000003",
			"0x0000000000000000000000000000000000000000000000000000000000000001"},
		"data": gainsWords(
			"000000000000000000000000000000000000000000000000000000001dcd6500", // delta 500 USDC
			zeroWord,
			oneWord, // open
			oneWord, // long
			"0000000000000000000000000000000000000000000000000000000077359400", // newLong 2,000 USDC
			"000000000000000000000000000000000000000000000000000000003b9aca00", // newShort 1,000 USDC
			zeroWord, zeroWord,
		),
		"blockNumber": "0x64", "transactionHash": "0xoi1", "logIndex": "0x0",
	}
	srv := mockRPCServer(t, "0x64", []map[string]any{oiLog})
	defer srv.Close()

	g := NewGainsArbitrum(srv.URL)
	g.tradingVarsURL = tv.URL
	g.lookbackBlocks = 20
	g.maxLogRange = 2000

	since := time.Now().Add(-windowSpan).UnixMilli()
	hist, err := g.FetchOIHistory("ETH", since)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(hist) != 2 {
		t.Fatalf("got %d readings, want a seed and the event", len(hist))
	}
	// Seed: USDC pre-state (1,500 + 1,000) x $1 plus WETH (1 + 1) x $2,000.
	if got := hist[0].usd; math.Abs(got-6500) > 0.01 {
		t.Fatalf("seed = %.2f, want 6500 (USDC pre-state plus the untouched WETH book)", got)
	}
	// After the event: USDC (2,000 + 1,000) plus WETH 4,000.
	if got := hist[1].usd; math.Abs(got-7000) > 0.01 {
		t.Fatalf("head = %.2f, want 7000", got)
	}

	// And the head of the reconstruction must equal what FetchOI reports from
	// the same trading-variables, which is the check that makes the series
	// trustworthy at all.
	live, err := g.FetchOI("ETH")
	if err != nil {
		t.Fatalf("FetchOI: %v", err)
	}
	if math.Abs(live-hist[len(hist)-1].usd) > 0.01 {
		t.Fatalf("reconstruction head %.2f against FetchOI %.2f", hist[len(hist)-1].usd, live)
	}
}

// The mean has to be weighted by how long each reading stood. Gains ETH had 67
// open-interest events across the whole of 2026-09-27 and 88 in the single
// hour it collapsed, so an average over readings reports the collapse as the
// day's normal state.
func TestTimeWeightedMean_IgnoresEventDensity(t *testing.T) {
	now := time.Now().UnixMilli()
	hour := int64(3600 * 1000)
	s := NewSampleWindow(windowSpan)
	// A book at 40M for 23 hours, then a busy hour of small readings.
	s.Add(now-24*hour, 40e6)
	for i := 0; i < 20; i++ {
		s.Add(now-hour+int64(i)*(hour/20), 2e6)
	}
	weighted := s.TimeWeightedMean(now)
	if weighted < 38e6 || weighted > 39.5e6 {
		t.Fatalf("time-weighted mean = %.0f, want about 38.4M", weighted)
	}
	// The average over readings would be dragged to the busy hour.
	naive := 0.0
	for _, e := range s.samples {
		naive += e.notional
	}
	naive /= float64(s.Len())
	if naive > 10e6 {
		t.Fatalf("the naive mean should be far lower, got %.0f", naive)
	}
	if s.Max() != 40e6 || s.Min() != 2e6 {
		t.Fatalf("peak=%v trough=%v", s.Max(), s.Min())
	}
}

// Two deployments are summed at every point either moved, each holding its
// last known value in between, rather than interleaved.
func TestMergeOISeries_StepsBothChains(t *testing.T) {
	out := mergeOISeries([][]oiReading{
		{{tsMs: 100, usd: 10}, {tsMs: 300, usd: 30}},
		{{tsMs: 100, usd: 1}, {tsMs: 200, usd: 2}},
	}, 100)
	if len(out) != 3 {
		t.Fatalf("got %d points, want 3 (100, 200, 300)", len(out))
	}
	want := map[int64]float64{100: 11, 200: 12, 300: 32}
	for _, r := range out {
		if math.Abs(r.usd-want[r.tsMs]) > 1e-9 {
			t.Errorf("at %d got %v, want %v", r.tsMs, r.usd, want[r.tsMs])
		}
	}
}

// A price series values a past reading at the price of its own time, and falls
// back to the head price when the window holds nothing earlier.
func TestPriceSeries_NearestAtOrBefore(t *testing.T) {
	ps := priceSeries{2: {{tsMs: 1000, usd: 2500}, {tsMs: 3000, usd: 2700}}}
	cases := []struct {
		at   int64
		want float64
	}{
		{500, 3000},  // nothing earlier: the head price
		{1000, 2500}, // exactly at a point
		{2000, 2500}, // between
		{4000, 2700}, // after the last
	}
	for _, c := range cases {
		if got := ps.priceAt(2, c.at, 3000); got != c.want {
			t.Errorf("priceAt(%d) = %v, want %v", c.at, got, c.want)
		}
	}
	if got := ps.priceAt(9, 2000, 1.0); got != 1.0 {
		t.Errorf("an unknown collateral should take the head price, got %v", got)
	}
}

// checkOIHead counts a disagreement rather than only logging it, because a
// reconstruction that has drifted from the venue is the one thing that would
// make this denominator worse than the snapshots it replaces.
func TestCheckOIHead_ReportsTheGap(t *testing.T) {
	// A reconstruction that has drifted from the venue is the one thing that
	// would make this denominator worse than the snapshots it replaces.
	if gap, ok := checkOIHead("wildly", "ETH", []oiReading{{tsMs: 1, usd: 100}}, 500); ok {
		t.Fatalf("a 5x disagreement passed, gap %.3f", gap)
	}
	if gap, ok := checkOIHead("quietly", "ETH", []oiReading{{tsMs: 1, usd: 1000}}, 1002); !ok {
		t.Fatalf("0.2%% apart was refused, gap %.4f", gap)
	}
	if _, ok := checkOIHead("empty", "ETH", nil, 1000); ok {
		t.Fatal("an empty history should not report agreement")
	}
}

// stubOIHistory is a source whose open interest is a read history rather than
// a snapshot, to prove the runner uses it and skips the warm-up.
type stubOIHistory struct{ readings []oiReading }

func (s *stubOIHistory) HasLiquidationSource() bool { return true }
func (s *stubOIHistory) FetchOI(string) (float64, error) {
	return s.readings[len(s.readings)-1].usd, nil
}
func (s *stubOIHistory) FetchVolume24hUSD(string) (float64, error) { return 500e6, nil }
func (s *stubOIHistory) FetchLiquidationsSince(string, int64) ([]LiqEvent, error) {
	return []LiqEvent{{Key: "l1", NotionalUSD: 1e6, TimestampMs: time.Now().UnixMilli()}}, nil
}
func (s *stubOIHistory) FetchOIHistory(string, int64) ([]oiReading, error) { return s.readings, nil }

// The shape of the bug: a book that held 43.5M dollars and now holds 2.7M. On
// the first tick, with history, the peak is the 43.5M and the rate is 2.3%,
// where an accumulated window would have seen only the 2.7M and printed 37%.
func TestRunTick_UsesOIHistoryOnTheFirstTick(t *testing.T) {
	now := time.Now().UnixMilli()
	hour := int64(3600 * 1000)
	src := &stubOIHistory{readings: []oiReading{
		{tsMs: now - 20*hour, usd: 43.5e6},
		{tsMs: now - 2*hour, usd: 2.7e6},
		{tsMs: now, usd: 2.7e6},
	}}
	va := VenueAsset{Venue: "stubhist", Asset: "ETH", Source: src}
	st := newPairState()
	if !runTick(va, st, now-windowSpan.Milliseconds(), 5*time.Minute) {
		t.Fatal("tick should succeed")
	}
	if !st.oiFromHistory {
		t.Fatal("the window was not rebuilt from history")
	}
	if peak := st.oi.Max(); math.Abs(peak-43.5e6) > 1 {
		t.Fatalf("peak = %.0f, want the 43.5M the book actually held", peak)
	}
	if trough := st.oi.Min(); math.Abs(trough-2.7e6) > 1 {
		t.Fatalf("trough = %.0f, want 2.7M", trough)
	}
	// One tick and the denominator is already the real one, where an
	// accumulated window would have held a single post-cascade reading and
	// waited an hour before publishing anything at all.
	if st.oi.Len() != 3 {
		t.Fatalf("window holds %d readings, want the three from history", st.oi.Len())
	}
	// The rate this produces is the defensible one: 1M over the 43.5M book.
	if rate := 1e6 / st.oi.Max() * 100; rate < 2.2 || rate > 2.4 {
		t.Fatalf("rate against the reconstructed peak = %.2f%%, want about 2.3%%", rate)
	}
	// Against what the accumulated window would have seen, the same flow
	// would have read an order of magnitude higher.
	if naive := 1e6 / 2.7e6 * 100; naive < 30 {
		t.Fatalf("the post-cascade denominator should read far higher, got %.1f%%", naive)
	}
}

// Only a source that really reads its own open-interest history may replace
// the window. If an ordinary source were mistaken for one, it would discard
// whatever the state file had just restored and leave a single fresh reading,
// so the peak, the mean and the trough would all print the same number. That
// is exactly the symptom a reading of the deployed board attributed to a
// broken restore, so it is worth making unmistakable which venues take this
// path.
func TestOnlyGainsImplementsOIHistory(t *testing.T) {
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	seen := map[string]bool{}
	for _, va := range cfg.Pairs {
		_, isHistory := va.Source.(oiHistorySource)
		seen[va.Venue] = seen[va.Venue] || isHistory
		if va.Venue == "gains" && !isHistory {
			t.Errorf("gains no longer reads its own open-interest history")
		}
		if va.Venue != "gains" && isHistory {
			t.Errorf("%s is treated as having open-interest history; its restored window would be discarded", va.Venue)
		}
	}
	if !seen["gains"] {
		t.Fatal("no gains pair was registered at all")
	}
}
