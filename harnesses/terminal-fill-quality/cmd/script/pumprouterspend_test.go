package main

import (
	"context"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"strings"
	"testing"
)

func addrTopic(a string) string {
	return "0x" + strings.Repeat("0", 24) + strings.TrimPrefix(strings.ToLower(a), "0x")
}

func transferLog(token, from, to string, raw *big.Int) evmLog {
	return evmLog{Address: token, Topics: []string{topicTransfer, addrTopic(from), addrTopic(to)}, Data: fmt.Sprintf("0x%064x", raw)}
}

// 0x2ccb…59c2 on Robinhood Chain, 2026-10-22, transfers as they appear in the
// receipt. The router spends 64.223432 USDG once; pump's executor then pays
// the same money to a USDG/WETH pool and unwraps the WETH for a v4 leg. Read
// from the executor as if it were the user, that was 128.47 given and a
// 5,021 bps terminal fee. The router's own spend is the single leg.
func TestPumpRouterSpendCountsTheRouterLegOnce(t *testing.T) {
	const (
		router = "0x5399d94d2cab7c252a6034042e1917a0e5e17a18"
		exec   = "0x24a4d86c8a76b00ee9566ed9c9ff4f0c3faf0da7"
		pool   = "0x72e46c9edf828002fdbfdd0952419790576c0f18"
		proxy  = "0xad875791df000000000000000000000000000000"
		usdg   = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
		weth   = "0x7943e237c7f95da44e0301572d358911207852fa"
		meme   = "0x8366a39cc6000000000000000000000000000000"
	)
	c := originChain{slug: "test-pump-spend", gas: "ETH-USD"}
	erc20Cache.Lock()
	erc20Cache.m[c.slug+":"+usdg] = erc20Meta{dec: 6, symbol: "USDG", ok: true}
	erc20Cache.m[c.slug+":"+weth] = erc20Meta{dec: 18, symbol: "WETH", ok: true}
	erc20Cache.m[c.slug+":"+meme] = erc20Meta{dec: 18, symbol: "HOOKLINE", ok: true}
	erc20Cache.Unlock()

	wethRaw, _ := new(big.Int).SetString("26920000000000000", 10)
	memeRaw, _ := new(big.Int).SetString("4567104789574000000000000", 10)
	logs := []evmLog{
		transferLog(usdg, router, exec, big.NewInt(64223432)),
		transferLog(usdg, exec, pool, big.NewInt(64223432)),
		transferLog(weth, pool, exec, wethRaw),
		transferLog(weth, exec, "0x0000000000000000000000000000000000000000", wethRaw),
		transferLog(meme, exec, router, memeRaw),
		transferLog(meme, router, proxy, memeRaw), // the token out: not a quote leg
	}
	got := pumpRouterSpendUSD(context.Background(), http.DefaultClient, c, []string{router}, logs, big.NewInt(0), map[string]float64{"ETH-USD": 2385})
	if math.Abs(got-64.223432) > 1e-9 {
		t.Fatalf("router spend %.6f, want 64.223432 (the executor's legs are the same money)", got)
	}

	// A router-to-router hop is internal and must not count.
	logs = append(logs, transferLog(usdg, router, router, big.NewInt(1_000_000)))
	if got2 := pumpRouterSpendUSD(context.Background(), http.DefaultClient, c, []string{router}, logs, big.NewInt(0), map[string]float64{"ETH-USD": 2385}); got2 != got {
		t.Fatalf("a router-to-router transfer moved the spend: %.6f", got2)
	}
}
