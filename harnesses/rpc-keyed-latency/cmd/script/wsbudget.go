package main

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// A monthly byte budget for the WebSocket arm, per provider and per region
// (this process is one region).
//
// Why bytes and not messages: Alchemy bills a subscription by the byte it
// pushes, not by the frame. Measured from this Mac on 2026-11-13 over 20 s per
// chain, a newHeads frame weighs 1.7 KB on Polygon and HyperEVM, 1.9 KB on
// Base and Arc, 2.4 KB on BNB and 3.9 KB on Ethereum, while a Solana slot
// notification is 139 bytes. Base pushes about five frames a second, so one
// chain carries more of the bill than Ethereum and Solana together, and a
// message count would hide exactly that.
//
// Same shape as the HTTP quota guard: in memory, reset on the calendar month
// AND on a restart. A restart under-counts, which errs towards spending, so
// the budgets below are runaway guards sized above the expected volume, not
// quotas. A provider with no budget is never paused.
var defaultWSByteBudgets = map[string]int64{
	// Seven chains under the ten-minute window come to about 9.3 GB a month
	// per region at the frame sizes above. 10 GiB lets that run and stops a
	// month in which a chain pushes far more than it did when measured, so a
	// WebSocket overrun cannot spend the key the nine HTTP boards share.
	"alchemy": 10 << 30,
}

var errWSByteBudget = errors.New("monthly WebSocket byte budget reached")

var wsByteBudgetUsed = promauto.NewGaugeVec(
	prometheus.GaugeOpts{
		Name: "rpc_ws_byte_budget_used_ratio",
		Help: "Fraction of this region's monthly WebSocket byte budget consumed per provider (sockets close at 1). Absent for a provider with no budget.",
	},
	[]string{"provider", "region"},
)

var wsBytesTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "rpc_ws_bytes_total",
		Help: "Bytes received on keyed WebSockets, for cost accounting on providers that bill by the byte.",
	},
	[]string{"provider", "chain", "region", "tier"},
)

// wsByteBudget is the provider's monthly budget in bytes for this region, or
// 0 for none. RPC_KEYED_WS_BYTE_BUDGET_<PROVIDER> overrides the default and
// "none" removes it.
func wsByteBudget(provider string) int64 {
	if v := strings.TrimSpace(os.Getenv("RPC_KEYED_WS_BYTE_BUDGET_" + strings.ToUpper(provider))); v != "" {
		if strings.EqualFold(v, "none") {
			return 0
		}
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return defaultWSByteBudgets[provider]
}

type wsByteGuard struct {
	mu    sync.Mutex
	month string
	used  map[string]int64
}

var wsBytes = &wsByteGuard{used: make(map[string]int64)}

func (g *wsByteGuard) rollover(now time.Time) {
	if m := now.UTC().Format("2006-01"); m != g.month {
		g.month = m
		g.used = make(map[string]int64)
	}
}

// add books n bytes against provider and reports whether its budget is now
// spent. Providers without a budget are counted and never refused.
func (g *wsByteGuard) add(provider string, n int, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.rollover(now)
	g.used[provider] += int64(n)
	budget := wsByteBudget(provider)
	if budget <= 0 {
		return false
	}
	ratio := float64(g.used[provider]) / float64(budget)
	wsByteBudgetUsed.WithLabelValues(provider, currentRegion).Set(ratio)
	return ratio >= 1
}

// exhausted reports whether provider has no budget left this month.
func (g *wsByteGuard) exhausted(provider string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.rollover(now)
	budget := wsByteBudget(provider)
	return budget > 0 && g.used[provider] >= budget
}
