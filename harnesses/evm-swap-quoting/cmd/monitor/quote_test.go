package main

import (
	"math"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"
)

func usdtPair() TestPair {
	return TestPair{
		Chain: "ethereum", ChainId: 1,
		TokenInSym: "ETH", TokenOutSym: "USDT",
		TokenInDec: 18, TokenOutDec: 6,
	}
}

// The output arrives in the destination token's smallest unit and has to be
// scaled by that token's decimals, not the input's. Getting the two the
// wrong way round turns 2,405 USDT into 2.4e-9 and the error is invisible
// on a chart that nobody has a reference for yet.
func TestOutAmountIsScaledByTheOutputTokenDecimals(t *testing.T) {
	pair := usdtPair()
	RecordQuote("zerox", pair, "us-east", Quote{
		LatencyMs: 400, OK: true, OutAmount: "2405576215", FeeBps: -1,
	})
	got := testutil.ToFloat64(
		quoteOutAmount.WithLabelValues("zerox", "ethereum", "us-east", "ETH/USDT"))
	if math.Abs(got-2405.576215) > 1e-6 {
		t.Errorf("expected 2405.576215 whole USDT, got %v", got)
	}
}

// An 18-decimal output exceeds what float64 holds exactly, so the
// conversion goes through big.Float before it ever becomes a gauge value.
func TestEighteenDecimalOutputSurvivesTheConversion(t *testing.T) {
	pair := usdtPair()
	pair.TokenOutSym, pair.TokenOutDec = "DAI", 18
	RecordQuote("kyberswap", pair, "us-east", Quote{
		LatencyMs: 200, OK: true, OutAmount: "2405576215123456789012", FeeBps: -1,
	})
	got := testutil.ToFloat64(
		quoteOutAmount.WithLabelValues("kyberswap", "ethereum", "us-east", "ETH/DAI"))
	if math.Abs(got-2405.576215123) > 1e-3 {
		t.Errorf("expected about 2405.58 whole DAI, got %v", got)
	}
}

// A provider that declares no fee must publish no fee series. Writing a
// zero would read as "charges nothing", which is a claim we cannot make:
// three of five providers declare nothing at all.
func TestUndeclaredFeePublishesNothing(t *testing.T) {
	pair := usdtPair()
	RecordQuote("kyberswap", pair, "eu-west", Quote{
		LatencyMs: 200, OK: true, OutAmount: "2391500000", FeeBps: -1,
	})
	if n := testutil.CollectAndCount(quoteFeeBps); n > 0 {
		for _, lbl := range [][]string{{"kyberswap", "ethereum", "eu-west", "ETH/USDT"}} {
			if v := testutil.ToFloat64(quoteFeeBps.WithLabelValues(lbl...)); v != 0 {
				t.Errorf("a provider that declares nothing must have no fee series, got %v", v)
			}
		}
	}
}

// LI.FI declares 0.0025 included; that is 25 bps and it is what the
// shortfall against the other providers measured.
func TestDeclaredFeeIsPublishedInBasisPoints(t *testing.T) {
	pair := usdtPair()
	RecordQuote("lifi", pair, "us-east", Quote{
		LatencyMs: 640, OK: true, OutAmount: "2390935864", FeeBps: 25,
	})
	got := testutil.ToFloat64(
		quoteFeeBps.WithLabelValues("lifi", "ethereum", "us-east", "ETH/USDT"))
	if got != 25 {
		t.Errorf("expected 25 bps, got %v", got)
	}
}

// Only three of five providers report the block they quoted against, and
// that is the only proof two quotes saw the same market. A zero must not be
// published as if it were block zero.
func TestBlockIsPublishedOnlyWhenTheProviderReportsIt(t *testing.T) {
	pair := usdtPair()
	RecordQuote("zerox", pair, "sgp", Quote{
		LatencyMs: 400, OK: true, OutAmount: "2405576215", FeeBps: -1, Block: 26227128,
	})
	if v := testutil.ToFloat64(
		quoteBlock.WithLabelValues("zerox", "ethereum", "sgp", "ETH/USDT")); v != 26227128 {
		t.Errorf("expected the reported block, got %v", v)
	}
	RecordQuote("kyberswap", pair, "sgp", Quote{
		LatencyMs: 200, OK: true, OutAmount: "2391500000", FeeBps: -1,
	})
	if v := testutil.ToFloat64(
		quoteBlock.WithLabelValues("kyberswap", "ethereum", "sgp", "ETH/USDT")); v != 0 {
		t.Errorf("a provider that reports no block must have no series, got %v", v)
	}
}

// Mobula returns `amountOutTokens`, already divided. Scaling it again by
// the output token's decimals published 0.00238 USDT against everyone
// else's 2389, which is the bug this flag exists to prevent. The synthetic
// tests above could not catch it because they invented the input; this one
// pins the real shape.
func TestAlreadyScaledAmountIsNotDividedTwice(t *testing.T) {
	pair := usdtPair()
	RecordQuote("mobula", pair, "us-east", Quote{
		LatencyMs: 853, OK: true, OutAmount: "2389.665942",
		FeeBps: -1, OutAlreadyScaled: true,
	})
	got := testutil.ToFloat64(
		quoteOutAmount.WithLabelValues("mobula", "ethereum", "us-east", "ETH/USDT"))
	if math.Abs(got-2389.665942) > 1e-6 {
		t.Errorf("expected 2389.665942 whole USDT, got %v", got)
	}
	// And the same number flagged the other way must land four orders of
	// magnitude apart, so the flag is doing the work rather than the value.
	RecordQuote("other", pair, "us-east", Quote{
		LatencyMs: 100, OK: true, OutAmount: "2389665942", FeeBps: -1,
	})
	raw := testutil.ToFloat64(
		quoteOutAmount.WithLabelValues("other", "ethereum", "us-east", "ETH/USDT"))
	if math.Abs(raw-2389.665942) > 1e-6 {
		t.Errorf("a raw smallest-unit amount must still scale, got %v", raw)
	}
}

// The real five-provider tick from 2026-10-19, 1 ETH to USDT. ParaSwap
// won it; LI.FI's 25.0 bps gap is its declared fee rather than its
// routing. These are the numbers the design rests on, so the test pins
// them instead of inventing round ones.
func realTick() map[string]Quote {
	q := func(out string) Quote {
		return Quote{OK: true, OutAmount: out, FeeBps: -1}
	}
	return map[string]Quote{
		"paraswap":  q("2394300000"),
		"kyberswap": q("2394150000"),
		"nordstern": q("2392600000"),
		"zerox":     q("2390710000"),
		"lifi":      q("2388320000"),
	}
}

func bucketCount(t *testing.T, provider, chain, pair string) uint64 {
	t.Helper()
	// The histogram has no direct value accessor, so read the metric out.
	ch := make(chan prometheus.Metric, 64)
	quoteShortfallBps.Collect(ch)
	close(ch)
	for m := range ch {
		var pb dto.Metric
		if err := m.Write(&pb); err != nil {
			continue
		}
		match := 0
		for _, l := range pb.GetLabel() {
			if l.GetName() == "provider" && l.GetValue() == provider {
				match++
			}
			if l.GetName() == "chain" && l.GetValue() == chain {
				match++
			}
			if l.GetName() == "pair" && l.GetValue() == pair {
				match++
			}
		}
		if match == 3 {
			return pb.GetHistogram().GetSampleCount()
		}
	}
	return 0
}

func histSum(t *testing.T, provider string) float64 {
	t.Helper()
	ch := make(chan prometheus.Metric, 64)
	quoteShortfallBps.Collect(ch)
	close(ch)
	for m := range ch {
		var pb dto.Metric
		if err := m.Write(&pb); err != nil {
			continue
		}
		for _, l := range pb.GetLabel() {
			if l.GetName() == "provider" && l.GetValue() == provider {
				return pb.GetHistogram().GetSampleSum()
			}
		}
	}
	return -1
}

func TestShortfallIsMeasuredAgainstTheBestOfTheSameTick(t *testing.T) {
	quoteShortfallBps.Reset()
	pair := usdtPair()
	RecordShortfall(pair, "us-east", realTick())

	// The winner gave up nothing.
	if got := histSum(t, "paraswap"); got != 0 {
		t.Errorf("the best quote of the tick must record 0 bps, got %v", got)
	}
	// LI.FI: (2394300000 - 2388320000) / 2394300000 = 24.98 bps, which is
	// the 0.25%% fee it declares.
	got := histSum(t, "lifi")
	if math.Abs(got-24.98) > 0.05 {
		t.Errorf("LI.FI should give up about 25 bps, got %v", got)
	}
	// 0x: (2394300000 - 2390710000) / 2394300000 = 14.99 bps.
	if g := histSum(t, "zerox"); math.Abs(g-14.99) > 0.05 {
		t.Errorf("0x should give up about 15 bps, got %v", g)
	}
	// Every provider in the tick is recorded once.
	for _, slug := range []string{"paraswap", "kyberswap", "nordstern", "zerox", "lifi"} {
		if n := bucketCount(t, slug, "ethereum", "ETH/USDT"); n != 1 {
			t.Errorf("%s should have one observation, got %d", slug, n)
		}
	}
}

// A provider answering alone has no best to miss. Recording 0 would hand
// it a perfect score for being the only one that replied.
func TestAFieldOfOneRecordsNothing(t *testing.T) {
	quoteShortfallBps.Reset()
	pair := usdtPair()
	RecordShortfall(pair, "us-east", map[string]Quote{
		"route": {OK: true, OutAmount: "2394300000", FeeBps: -1},
	})
	if n := bucketCount(t, "route", "ethereum", "ETH/USDT"); n != 0 {
		t.Errorf("a field of one must record nothing, got %d observations", n)
	}
	if v := testutil.ToFloat64(
		quoteTickField.WithLabelValues("ethereum", "ETH/USDT")); v != 1 {
		t.Errorf("the field size must still be published, got %v", v)
	}
}

// Mobula returns whole tokens while everyone else returns the smallest
// unit. Comparing them unconverted would read Mobula as 10^6 times worse
// and hand every tick to someone else.
func TestAlreadyScaledQuoteIsComparedOnTheSameScale(t *testing.T) {
	quoteShortfallBps.Reset()
	pair := usdtPair()
	RecordShortfall(pair, "us-east", map[string]Quote{
		"kyberswap": {OK: true, OutAmount: "2394150000", FeeBps: -1},
		"mobula":    {OK: true, OutAmount: "2394.30", FeeBps: -1, OutAlreadyScaled: true},
	})
	// Mobula is the higher of the two, so it wins and gives up nothing.
	if got := histSum(t, "mobula"); got != 0 {
		t.Errorf("Mobula held the best quote and should record 0, got %v", got)
	}
	if got := histSum(t, "kyberswap"); !(got > 0 && got < 10) {
		t.Errorf("KyberSwap should trail by a fraction of a bp, got %v", got)
	}
}
