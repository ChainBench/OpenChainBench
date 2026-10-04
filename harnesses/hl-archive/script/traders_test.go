package script

import (
	"math"
	"strings"
	"testing"
)

// The envelope shape is the venue's, verbatim: every figure a string,
// and windowPerformances a heterogeneous [name, figures] array. Row 1
// carries the case the audit exists for (PnL on zero volume), row 3 an
// ROI that cannot be read as a return, and row 4 a malformed window that
// must degrade to zeros rather than fail the run.
const sampleLeaderboard = `{"leaderboardRows":[
 {"ethAddress":"0xAAA","accountValue":"50","windowPerformances":[
   ["day",{"pnl":"5","roi":"0.1","vlm":"0"}],
   ["allTime",{"pnl":"100","roi":"0.5","vlm":"0"}]]},
 {"ethAddress":"0xBBB","accountValue":"10","windowPerformances":[
   ["day",{"pnl":"-1","roi":"-0.01","vlm":"20"}],
   ["allTime",{"pnl":"-40","roi":"-0.4","vlm":"1000"}]]},
 {"ethAddress":"0xCCC","accountValue":"5","windowPerformances":[
   ["allTime",{"pnl":"20","roi":"200","vlm":"500"}]]},
 {"ethAddress":"0xDDD","accountValue":"not-a-number","windowPerformances":[
   ["allTime",{"pnl":"oops","roi":"","vlm":"nope"}]]}
]}`

func TestParseLeaderboard(t *testing.T) {
	accs, err := ParseLeaderboard(strings.NewReader(sampleLeaderboard))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(accs) != 4 {
		t.Fatalf("accounts = %d, want 4", len(accs))
	}
	// Addresses are lowercased so the Upstash row keys and any future
	// join against the builder archive agree on one casing.
	if accs[0].Address != "0xaaa" {
		t.Errorf("address = %q, want lowercased 0xaaa", accs[0].Address)
	}
	if got := accs[0].AllTime().PnL; got != 100 {
		t.Errorf("allTime pnl = %v, want 100", got)
	}
	if got := accs[0].Windows["day"].PnL; got != 5 {
		t.Errorf("day pnl = %v, want 5", got)
	}
	// An unreadable figure is worth zero, not an aborted archive.
	if got := accs[3].AllTime().PnL; got != 0 {
		t.Errorf("unparseable pnl = %v, want 0", got)
	}
	if got := accs[3].Equity; got != 0 {
		t.Errorf("unparseable equity = %v, want 0", got)
	}
}

func TestParseLeaderboardRejectsEmpty(t *testing.T) {
	if _, err := ParseLeaderboard(strings.NewReader(`{"leaderboardRows":[]}`)); err == nil {
		t.Fatal("want an error on an empty blob: a silent zero would publish as a real reading")
	}
}

func TestAudit(t *testing.T) {
	accs, err := ParseLeaderboard(strings.NewReader(sampleLeaderboard))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	in := Audit(accs)

	// Aggregate: 100 - 40 + 20 + 0.
	if in.AggPnL != 80 {
		t.Errorf("AggPnL = %v, want 80", in.AggPnL)
	}
	if in.AggEquity != 65 {
		t.Errorf("AggEquity = %v, want 65", in.AggEquity)
	}
	if in.AggVlm != 1500 {
		t.Errorf("AggVlm = %v, want 1500", in.AggVlm)
	}
	// Winners are strictly above zero, so the unparseable row (0) is not
	// one: 0xAAA and 0xCCC of four rows.
	if in.Winners != 2 {
		t.Errorf("Winners = %d, want 2", in.Winners)
	}
	if math.Abs(in.WinnersPct-50) > 1e-9 {
		t.Errorf("WinnersPct = %v, want 50", in.WinnersPct)
	}
	if in.LosersPnL != -40 {
		t.Errorf("LosersPnL = %v, want -40", in.LosersPnL)
	}
	// The cohort the whole audit is about.
	if in.ZeroVlmAccounts != 1 {
		t.Errorf("ZeroVlmAccounts = %d, want 1", in.ZeroVlmAccounts)
	}
	if in.ZeroVlmPnL != 100 {
		t.Errorf("ZeroVlmPnL = %v, want 100", in.ZeroVlmPnL)
	}
	// 100 of an aggregate of 80: the share exceeds 100 % because the
	// losers net the denominator down. Surprising and correct, so it is
	// pinned here rather than clamped in the code.
	if math.Abs(in.ZeroVlmPnLPct-125) > 1e-9 {
		t.Errorf("ZeroVlmPnLPct = %v, want 125", in.ZeroVlmPnLPct)
	}
	if in.ROIOutliers != 1 {
		t.Errorf("ROIOutliers = %d, want 1 (the 200 = 20,000%% row)", in.ROIOutliers)
	}
	// Fewer than a hundred rows, so the top hundred is everything.
	if math.Abs(in.Top100PnLPct-100) > 1e-9 {
		t.Errorf("Top100PnLPct = %v, want 100", in.Top100PnLPct)
	}
	// 0xDDD's lifetime window did not read, and that is published rather
	// than absorbed.
	if in.MalformedRows != 1 {
		t.Errorf("MalformedRows = %d, want 1", in.MalformedRows)
	}
}

// An unreadable volume is not a zero volume.
//
// Regression guard for the way this audit could quietly lie: the
// zero-volume cohort is the headline, it is defined as "volume zero,
// PnL not", and a lenient parse turns any future format change into
// thousands of fabricated members of that cohort. The live blob had no
// such row on 2026-10-03, so only this test keeps the distinction real.
func TestUnreadableVolumeIsNotZeroVolume(t *testing.T) {
	const blob = `{"leaderboardRows":[
	 {"ethAddress":"0xEEE","accountValue":"10","windowPerformances":[
	   ["allTime",{"pnl":"500","roi":"0.1","vlm":"n/a"}]]}
	]}`
	accs, err := ParseLeaderboard(strings.NewReader(blob))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if accs[0].AllTimeOK {
		t.Error("AllTimeOK should be false when vlm did not parse")
	}
	in := Audit(accs)
	if in.ZeroVlmAccounts != 0 {
		t.Errorf("ZeroVlmAccounts = %d, want 0: an unparseable volume is not a zero", in.ZeroVlmAccounts)
	}
	if in.ZeroVlmPnL != 0 {
		t.Errorf("ZeroVlmPnL = %v, want 0", in.ZeroVlmPnL)
	}
	if in.MalformedRows != 1 {
		t.Errorf("MalformedRows = %d, want 1 so the shape change is visible", in.MalformedRows)
	}
	// The PnL still counts toward the aggregate: the row is real, only
	// its volume is unreadable.
	if in.AggPnL != 500 {
		t.Errorf("AggPnL = %v, want 500", in.AggPnL)
	}
}

func TestAuditEmptyIsZeroNotNaN(t *testing.T) {
	in := Audit(nil)
	if in.Accounts != 0 || in.WinnersPct != 0 || in.ZeroVlmPnLPct != 0 {
		t.Fatalf("empty audit = %+v, want zeros", in)
	}
	// A NaN reaching a gauge publishes as a real sample and poisons every
	// query that touches it.
	for name, v := range map[string]float64{
		"WinnersPct": in.WinnersPct, "ZeroVlmPnLPct": in.ZeroVlmPnLPct,
		"Top100PnLPct": in.Top100PnLPct,
	} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			t.Errorf("%s = %v, want a finite number", name, v)
		}
	}
}

// The info API shape, with the figures from the account probed on
// 2026-10-03: allTime $198.89 m against perpAllTime $162.79 m.
const samplePortfolio = `[
 ["day",{"accountValueHistory":[[1,"1"]],"pnlHistory":[[1,"1"]],"vlm":"1"}],
 ["allTime",{"accountValueHistory":[[1,"0"],[2,"119678434"]],"pnlHistory":[[1,"0"],[2,"198893626"]]}],
 ["perpAllTime",{"accountValueHistory":[[1,"0"],[2,"100"]],"pnlHistory":[[1,"0"],[2,"162788845"]]}]
]`

func TestParsePortfolio(t *testing.T) {
	s, err := ParsePortfolio("0xabc", strings.NewReader(samplePortfolio))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if s.PnL != 198893626 {
		t.Errorf("PnL = %v, want 198893626", s.PnL)
	}
	if s.PerpPnL != 162788845 {
		t.Errorf("PerpPnL = %v, want 162788845", s.PerpPnL)
	}
	// Equity comes from the allTime window, not the perp mirror.
	if s.Equity != 119678434 {
		t.Errorf("Equity = %v, want 119678434", s.Equity)
	}
	if got := s.NonPerpPnL(); got != 36104781 {
		t.Errorf("NonPerpPnL = %v, want 36104781", got)
	}
}

func TestParsePortfolioNeedsAllTime(t *testing.T) {
	_, err := ParsePortfolio("0xabc", strings.NewReader(`[["day",{"pnlHistory":[[1,"5"]]}]]`))
	if err == nil {
		t.Fatal("want an error when allTime is absent: a zero would read as a flat account")
	}
}

func TestDecompose(t *testing.T) {
	d := Decompose([]PortfolioSample{
		{Address: "a", PnL: 198893626, PerpPnL: 162788845},
		{Address: "b", PnL: 100, PerpPnL: 100}, // pure perp
		{Address: "c", PnL: 50, PerpPnL: -50},  // perps lost, spot carried
	}, 2)
	if d.Sampled != 3 || d.Failed != 2 {
		t.Errorf("Sampled/Failed = %d/%d, want 3/2", d.Sampled, d.Failed)
	}
	// 36104781 + 0 + 100.
	if d.NonPerpPnL != 36104881 {
		t.Errorf("NonPerpPnL = %v, want 36104881", d.NonPerpPnL)
	}
	// Counted, not weighted: 'b' is pure perp so only a and c qualify.
	if d.WithNonPerp != 2 {
		t.Errorf("WithNonPerp = %d, want 2", d.WithNonPerp)
	}
	want := 100 * 36104881.0 / 198893776.0
	if math.Abs(d.NonPerpPct-want) > 1e-9 {
		t.Errorf("NonPerpPct = %v, want %v", d.NonPerpPct, want)
	}
}

func TestRankRowsOrdersAndFlags(t *testing.T) {
	accs, err := ParseLeaderboard(strings.NewReader(sampleLeaderboard))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	rows := rankRows(accs)
	if rows[0].PnL != 100 || rows[len(rows)-1].PnL != -40 {
		t.Fatalf("not sorted by PnL desc: %v .. %v", rows[0].PnL, rows[len(rows)-1].PnL)
	}
	// The zero-volume row stays in the table, marked, rather than being
	// dropped into a flattering silence.
	if !rows[0].NoVolume {
		t.Error("top row should be flagged NoVolume")
	}
	if rows[1].NoVolume {
		t.Error("a row with real volume should not be flagged")
	}
}
