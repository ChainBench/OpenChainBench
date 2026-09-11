package main

import (
	"context"
	"os"
	"testing"
	"time"
)

const krakenFixture = `{"error":[],"result":{"XXBTZEUR":{"a":["66437.40000","1","1.000"],"b":["66437.30000","2","2.000"]},"XETHZEUR":{"a":["2120.57000","5","5.000"],"b":["2120.56000","1","1.000"]},"USDCEUR":{"a":["0.86150","1000","1000.000"],"b":["0.86140","500","500.000"]}}}`

func TestParseKrakenMid(t *testing.T) {
	m, err := parseKraken([]byte(krakenFixture))
	if err != nil {
		t.Fatal(err)
	}
	if !near(m["btc"], 66437.35, 1e-6) || !near(m["eth"], 2120.565, 1e-6) || !near(m["usdc"], 0.86145, 1e-9) {
		t.Fatalf("mids = %v", m)
	}
}

func TestParseKrakenError(t *testing.T) {
	if _, err := parseKraken([]byte(`{"error":["EQuery:Unknown asset pair"],"result":{}}`)); err == nil {
		t.Fatal("expected error")
	}
}

// Pyth prices arrive as integer strings with an exponent. 6643700000000 ×
// 10^-8 = 66437. EUR/USD 116000000 × 10^-8 = 1.16 → BTC/EUR = 57273.28.
func TestParsePythCompositeEUR(t *testing.T) {
	body := `{"parsed":[
	 {"id":"` + pythFeeds["btc"] + `","price":{"price":"6643700000000","expo":-8}},
	 {"id":"` + pythFeeds["eth"] + `","price":{"price":"212056000000","expo":-8}},
	 {"id":"` + pythFeeds["usdc"] + `","price":{"price":"99990000","expo":-8}},
	 {"id":"` + pythFeeds["eurusd"] + `","price":{"price":"116000000","expo":-8}}]}`
	m, err := parsePyth([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if !near(m["btc"], 66437.0/1.16, 1e-6) {
		t.Fatalf("btc eur = %v", m["btc"])
	}
	if !near(m["usdc"], 0.9999/1.16, 1e-9) {
		t.Fatalf("usdc eur = %v", m["usdc"])
	}
}

func TestParsePythMissingFX(t *testing.T) {
	body := `{"parsed":[{"id":"` + pythFeeds["btc"] + `","price":{"price":"1","expo":0}}]}`
	if _, err := parsePyth([]byte(body)); err == nil {
		t.Fatal("expected error without EUR/USD")
	}
}

// Live integration: both references must answer and agree within 1 %.
// Skipped unless OCB_LIVE=1 so CI stays hermetic.
func TestLiveSpotReferencesAgree(t *testing.T) {
	if os.Getenv("OCB_LIVE") != "1" {
		t.Skip("set OCB_LIVE=1")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	k, err := fetchKraken(ctx)
	if err != nil {
		t.Fatalf("kraken: %v", err)
	}
	p, err := fetchPyth(ctx)
	if err != nil {
		t.Fatalf("pyth: %v", err)
	}
	for _, a := range []string{"btc", "eth", "usdc"} {
		if k[a] <= 0 || p[a] <= 0 {
			t.Fatalf("%s: kraken=%v pyth=%v", a, k[a], p[a])
		}
		div := (k[a] - p[a]) / p[a] * 1e4
		t.Logf("%s kraken=%.4f pyth=%.4f divergence=%.1f bps", a, k[a], p[a], div)
		if div > 100 || div < -100 {
			t.Errorf("%s: references diverge by %.1f bps", a, div)
		}
	}
}
