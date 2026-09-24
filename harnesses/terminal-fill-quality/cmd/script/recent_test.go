package main

import (
	"encoding/json"
	"testing"
)

// mkSwaps builds `n` swaps for one terminal, oldest first, with strictly
// increasing timestamps offset by `base` so the ordering of the merged
// result is checkable.
func mkSwaps(terminal string, n int, base int64) []Swap {
	out := make([]Swap, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, Swap{Terminal: terminal, Sig: terminal, Time: base + int64(i)})
	}
	return out
}

// The table under the board is its evidence, so every row that publishes
// a figure must appear in it. The global tail this replaced gave the
// busiest terminals everything and six ranked rows nothing at all.
func TestRecentCoversEveryTerminal(t *testing.T) {
	st := &State{}
	// One firehose and three quiet terminals, interleaved so a tail of
	// the flat slice would be almost entirely the firehose.
	st.Swaps = append(st.Swaps, mkSwaps("busy", 2000, 0)...)
	st.Swaps = append(st.Swaps, mkSwaps("quiet-a", 3, 5000)...)
	st.Swaps = append(st.Swaps, mkSwaps("quiet-b", 1, 6000)...)
	st.Swaps = append(st.Swaps, mkSwaps("quiet-c", 40, 7000)...)

	got := recent(st, 6, 900, nil)

	seen := map[string]int{}
	for _, s := range got {
		seen[s.Terminal]++
	}
	for _, want := range []string{"busy", "quiet-a", "quiet-b", "quiet-c"} {
		if seen[want] == 0 {
			t.Fatalf("terminal %q has no rows in the sample: %v", want, seen)
		}
	}
	if seen["quiet-a"] != 3 {
		t.Fatalf("quiet-a has 3 swaps in the window, sample kept %d", seen["quiet-a"])
	}
	if seen["quiet-b"] != 1 {
		t.Fatalf("quiet-b has 1 swap in the window, sample kept %d", seen["quiet-b"])
	}
	// No per-row ceiling by design: a row that carries most of the flow
	// is supposed to carry most of the sample. What must hold is that it
	// does not do so by starving anyone, which the floor checks above.
	if len(got) > 900 {
		t.Fatalf("sample of %d exceeds the total budget of 900", len(got))
	}
}

// The ceiling is a payload guard, and it must not reintroduce the bug it
// replaced by spending itself on whoever is loudest.
func TestRecentTotalCeilingLeavesNobodyOut(t *testing.T) {
	st := &State{}
	for _, slug := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		st.Swaps = append(st.Swaps, mkSwaps(slug, 50, 0)...)
	}
	const total = 20
	got := recent(st, 1, total, nil)
	if len(got) > total {
		t.Fatalf("sample of %d exceeds the ceiling of %d", len(got), total)
	}
	seen := map[string]int{}
	for _, s := range got {
		seen[s.Terminal]++
	}
	if len(seen) != 8 {
		t.Fatalf("ceiling dropped terminals: %d of 8 represented (%v)", len(seen), seen)
	}
}

// Sorted oldest to newest, so the table reads as a timeline.
func TestRecentIsTimeOrdered(t *testing.T) {
	st := &State{}
	st.Swaps = append(st.Swaps, mkSwaps("a", 5, 100)...)
	st.Swaps = append(st.Swaps, mkSwaps("b", 5, 0)...)
	got := recent(st, 6, 900, nil)
	for i := 1; i < len(got); i++ {
		if got[i].Time < got[i-1].Time {
			t.Fatalf("not time-ordered at %d: %d before %d", i, got[i-1].Time, got[i].Time)
		}
	}
}

// Binance's row is the pooled product; its swaps are stored under
// binance-wallet-base and -ethereum, so without the product stamp the
// row's own audit table matched none of its 196 transactions.
func TestRecentStampsTheProductForAPooledRow(t *testing.T) {
	st := &State{}
	st.Swaps = append(st.Swaps, mkSwaps("binance-wallet-base", 4, 0)...)
	st.Swaps = append(st.Swaps, mkSwaps("binance-wallet-ethereum", 4, 100)...)
	st.Swaps = append(st.Swaps, mkSwaps("gmgn", 4, 200)...)

	for _, s := range recent(st, 6, 900, nil) {
		switch s.Terminal {
		case "binance-wallet-base", "binance-wallet-ethereum":
			if s.Product != "binance" {
				t.Fatalf("%s should roll up to binance, got %q", s.Terminal, s.Product)
			}
		case "gmgn":
			// A row that is its own product carries no stamp, so the
			// payload does not repeat the terminal on every swap.
			if s.Product != "" {
				t.Fatalf("gmgn is its own row, want no product stamp, got %q", s.Product)
			}
		}
	}
}

// A chain row keeps its own identity while pointing at its product, so
// /products/gmgn and the gmgn-ethereum row can both find the swap.
func TestRecentStampsTheProductForAChainRow(t *testing.T) {
	st := &State{}
	st.Swaps = append(st.Swaps, mkSwaps("gmgn-ethereum", 3, 0)...)
	got := recent(st, 6, 900, nil)
	if len(got) != 3 {
		t.Fatalf("want 3 swaps, got %d", len(got))
	}
	for _, s := range got {
		if s.Terminal != "gmgn-ethereum" || s.Product != "gmgn" {
			t.Fatalf("want terminal gmgn-ethereum product gmgn, got %q / %q", s.Terminal, s.Product)
		}
	}
}

// The bug the coverage tests above could not see: a sample can cover
// every row and still be weighted wrongly.
//
// A pooled product row shows the union of its members and its median
// weights those members by flow. Sampling members equally made the union
// look nothing like the median — pump.fun's Solana leg carried 55% of
// the flow and 12% of the table, so the table sat above the figure it
// was supposed to support.
func TestRecentSamplesInProportionToFlow(t *testing.T) {
	st := &State{}
	// One member with the flow, three without: 70% / 10% / 10% / 10%.
	st.Swaps = append(st.Swaps, mkSwaps("pump-fun", 700, 0)...)
	st.Swaps = append(st.Swaps, mkSwaps("pump-fun-bnb", 100, 1000)...)
	st.Swaps = append(st.Swaps, mkSwaps("pump-fun-base", 100, 2000)...)
	st.Swaps = append(st.Swaps, mkSwaps("pump-fun-arc", 100, 3000)...)

	got := recent(st, 6, 200, nil)
	seen := map[string]int{}
	for _, s := range got {
		seen[s.Terminal]++
	}
	dominant := float64(seen["pump-fun"]) / float64(len(got))
	if dominant < 0.35 {
		t.Fatalf("the row holding 70%% of the flow got %.0f%% of the sample (%v); "+
			"equal shares are what made a pooled row disagree with its own median",
			dominant*100, seen)
	}
	// ...but not at the price of the quiet rows disappearing again.
	for _, slug := range []string{"pump-fun-bnb", "pump-fun-base", "pump-fun-arc"} {
		if seen[slug] < 6 {
			t.Fatalf("%s fell under the floor of 6 (%d); coverage is the reason "+
				"per-row sampling replaced the global tail", slug, seen[slug])
		}
	}
}

// A row with fewer swaps than the floor shows all of them rather than
// being padded or dropped.
func TestRecentKeepsEverythingBelowTheFloor(t *testing.T) {
	st := &State{}
	st.Swaps = append(st.Swaps, mkSwaps("busy", 5000, 0)...)
	st.Swaps = append(st.Swaps, mkSwaps("tiny", 2, 9000)...)
	seen := 0
	for _, s := range recent(st, 6, 300, nil) {
		if s.Terminal == "tiny" {
			seen++
		}
	}
	if seen != 2 {
		t.Fatalf("tiny has 2 swaps in the window, sample kept %d", seen)
	}
}

// A funding leg is a bridge, not a fill: compute() leaves it out of the
// product's pooled figure, so it must not be stamped into the pooled
// row's evidence either. pump.fun's members summed to 483 against a
// pooled 448, and the 35 in between were this.
func TestRecentDoesNotStampFundingLegsOntoTheProduct(t *testing.T) {
	st := &State{}
	st.Swaps = append(st.Swaps, mkSwaps("pump-fun-funding", 20, 0)...)
	st.Swaps = append(st.Swaps, mkSwaps("pump-fun-base", 20, 500)...)

	for _, s := range recent(st, 6, 900, nil) {
		switch s.Terminal {
		case "pump-fun-funding":
			if s.Product != "" {
				t.Fatalf("funding leg stamped onto %q; the pooled figure excludes it", s.Product)
			}
		case "pump-fun-base":
			if s.Product != "pump-fun" {
				t.Fatalf("chain row should roll up to pump-fun, got %q", s.Product)
			}
		}
	}
}

// The sample has to follow the same weight the statistic follows.
//
// compute() builds a pooled median with weightOf[slug] = attempts /
// sampled rows, under a comment that names the trap outright: "a median
// over the plain concatenation would describe the sampler, not the
// users". The audit table WAS that plain concatenation.
//
// Real pump.fun shape on 2026-09-24: Solana is 655,117 attempts and 123
// priced swaps (0.02%), Robinhood 18,780 and 84 (0.45%), BNB 6,783 and
// 82 (1.2%). Solana is 95% of the flow and 27% of the rows, so a sample
// drawn on rows cannot reproduce a median weighted on attempts.
func TestRecentFollowsFlowNotCollectedSwaps(t *testing.T) {
	st := &State{}
	st.Swaps = append(st.Swaps, mkSwaps("pump-fun", 123, 0)...)
	st.Swaps = append(st.Swaps, mkSwaps("pump-fun-robinhood", 84, 2000)...)
	st.Swaps = append(st.Swaps, mkSwaps("pump-fun-bnb", 82, 4000)...)
	flow := map[string]float64{
		"pump-fun":           655117,
		"pump-fun-robinhood": 18780,
		"pump-fun-bnb":       6783,
	}

	seen := map[string]int{}
	got := recent(st, 6, 200, flow)
	for _, s := range got {
		seen[s.Terminal]++
	}
	// Solana holds 96% of the flow. It cannot take all of the sample,
	// because only 123 of its swaps exist, but it has to dominate.
	share := float64(seen["pump-fun"]) / float64(len(got))
	if share < 0.6 {
		t.Fatalf("the row carrying 96%% of the flow took %.0f%% of the sample (%v); "+
			"weighting by collected swaps instead of flow is what made the pooled "+
			"table read 375 against a published 254", share*100, seen)
	}
	// The thin chains keep their floor: a row nobody can price much of
	// is still a row a reader may want to check.
	for _, slug := range []string{"pump-fun-robinhood", "pump-fun-bnb"} {
		if seen[slug] < 6 {
			t.Fatalf("%s fell under the floor of 6 (%d)", slug, seen[slug])
		}
	}
}

// Without a flow map the sampler falls back to swap counts, so a caller
// with no stats to hand still gets a spread rather than nothing.
func TestRecentFallsBackToSwapCountsWithoutFlow(t *testing.T) {
	st := &State{}
	st.Swaps = append(st.Swaps, mkSwaps("a", 300, 0)...)
	st.Swaps = append(st.Swaps, mkSwaps("b", 30, 1000)...)
	seen := map[string]int{}
	for _, s := range recent(st, 6, 200, nil) {
		seen[s.Terminal]++
	}
	if seen["a"] <= seen["b"] {
		t.Fatalf("fallback should still favour the busier row, got %v", seen)
	}
	if seen["b"] < 6 {
		t.Fatalf("b fell under the floor (%d)", seen["b"])
	}
}

// The rows shown have to cover the window the figure covers.
//
// byTerm is newest-first and the quota used to take the head of it, so a
// row cut to its floor showed the last few swaps — a slice of the past
// hour standing in for a 24h median. pump-fun-ethereum read 1719 against
// a published 646 that way, with one row of nine below the median, which
// is word for word the complaint that started all this.
func TestRecentSpreadsAcrossTheWindowNotJustTheNewest(t *testing.T) {
	st := &State{}
	// 240 swaps an hour apart: index 0 is the oldest, 239 the newest.
	st.Swaps = append(st.Swaps, mkSwaps("solo", 240, 0)...)

	got := recent(st, 12, 40, nil)
	if len(got) < 12 {
		t.Fatalf("expected at least the floor, got %d", len(got))
	}
	first, last := got[0].Time, got[len(got)-1].Time
	span := last - first
	// The head-of-list sampler would return a run at one end; an even
	// spread covers most of the 239-hour range.
	if span < 200 {
		t.Fatalf("sample spans %d of 239 time units — it is a slice, not a spread", span)
	}

	// And it should not bunch: the largest gap between consecutive rows
	// stays close to the even spacing rather than one jump covering most
	// of the window.
	widest := int64(0)
	for i := 1; i < len(got); i++ {
		if g := got[i].Time - got[i-1].Time; g > widest {
			widest = g
		}
	}
	if widest > int64(3*240/len(got)) {
		t.Fatalf("largest gap %d is far above the even spacing %d", widest, 240/len(got))
	}
}

// A row with fewer swaps than its quota keeps all of them, in order.
func TestSpreadKeepsEverythingWhenItFits(t *testing.T) {
	rows := mkSwaps("x", 5, 0)
	got := spread(rows, 12)
	if len(got) != 5 {
		t.Fatalf("want all 5 rows, got %d", len(got))
	}
	for i := 1; i < len(got); i++ {
		if got[i].Time <= got[i-1].Time {
			t.Fatalf("order not preserved at %d", i)
		}
	}
}

// PublicSwap is the contract with the site: src/lib/terminal-fills.ts
// reads these keys and renders nothing else. Trimming the payload is
// what let the sample grow enough for the per-chain floor and the
// flow weighting to stop competing, so the temptation to trim further
// will come back — this is the line it must not cross.
//
// If the table starts reading a new key, add it here and to PublicSwap
// together. If one disappears from here, the table silently renders a
// blank column instead of failing, which is why this is a test.
func TestPublicSwapCarriesEveryFieldTheSiteReads(t *testing.T) {
	want := []string{
		"sig", "terminal", "product", "time", "side", "quote", "venue",
		"chain", "hops", "x_mint", "in_tx", "rent_q", "quote_usd",
		"trade_usd", "priced", "scanned", "flag", "ref_src", "ref_age_s",
		"loss_bps", "pool_bps", "terminal_bps", "network_bps",
		"relay_bps", "other_bps", "sandwich",
	}

	age := int64(3)
	loss, pool, other := 120.0, 40.0, 7.0
	full := publicSwaps([]Swap{{
		Sig: "s", Terminal: "gmgn", Product: "gmgn", Time: 1, Side: "buy",
		Quote: "SOL", Venue: "raydium", Chain: "base", Hops: 1, XMint: "x",
		InTx: "t", RentQ: 1, QuoteUSD: 1, TradeUSD: 1, Priced: true,
		Scanned: true, Flag: "f", RefSrc: "reserves", RefAgeS: &age,
		LossBps: &loss, PoolBps: &pool, TerminalBps: 1, NetworkBps: 1,
		RelayBps: 1, OtherBps: &other,
		Sandwich: &Sandwich{},
	}})

	raw, err := json.Marshal(full[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, k := range want {
		if _, ok := got[k]; !ok {
			t.Fatalf("PublicSwap no longer publishes %q; the audit table reads it", k)
		}
	}
	// And the other direction: anything published that nothing reads is
	// budget spent on a column that does not exist.
	allowed := map[string]bool{}
	for _, k := range want {
		allowed[k] = true
	}
	for k := range got {
		if !allowed[k] {
			t.Fatalf("PublicSwap publishes %q, which the site does not read; "+
				"the row budget is what the sample size depends on", k)
		}
	}
}
