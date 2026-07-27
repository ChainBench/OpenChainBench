package main

import (
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	// Capture all log output into a ring buffer (last 500 lines) so we can expose
	// it via /logs endpoint without needing Railway dashboard access.
	logRing := NewLogBuffer(os.Stdout, 500)
	log.SetOutput(logRing)

	log.Println("🚀 Bridge Latency Monitor starting...")

	// Load configuration
	config, err := loadEnv()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	// Log configuration
	config.LogConfig()

	// SIMULATE_BALANCES is a dry-run testing aid only. In any mode that can
	// broadcast, phantom balances could green-light real transfers, so the
	// flag is ignored everywhere outside dry-run (see SimulateBalances).
	if config.SimulateBalances && config.ExecutionMode != string(ModeDryRun) {
		log.Printf("⚠️  SIMULATE_BALANCES=true is set but EXECUTION_MODE is %q: simulated balances are IGNORED outside dry-run", config.ExecutionMode)
	}

	// Initialize bridges
	var mobulaBridge *MobulaBridge
	if config.MobulaAPIKey != "" {
		mobulaBridge = NewMobulaBridge(config.MobulaAPIKey)
		log.Println("✅ Mobula bridge initialized")
	} else {
		log.Println("⚠️  Mobula API key not configured, skipping")
	}

	relayBridge := NewRelayBridge()
	log.Println("✅ Relay bridge initialized (no key needed)")

	debridgeBridge := NewDebridgeBridge()
	log.Println("✅ Debridge bridge initialized (no key needed)")

	lifiBridge := NewLiFiBridge(config.LiFiAPIKey)
	if config.LiFiAPIKey != "" {
		log.Println("✅ Li.Fi bridge initialized (with API key)")
	} else {
		log.Println("⚠️  Li.Fi bridge initialized (no API key - rate limited to 75 req/2h)")
	}

	acrossBridge := NewAcrossBridge()
	log.Println("✅ Across bridge initialized (no key needed)")

	nearIntentsBridge := NewNearIntentsBridge(config.NearIntentsAPIKey)
	if config.NearIntentsAPIKey != "" {
		log.Println("✅ Near Intents bridge initialized (with partner JWT)")
	} else {
		log.Println("⚠️  Near Intents bridge initialized (anonymous mode - adds ~10 bps appFee and lower solver priority)")
	}

	squidBridge := NewSquidBridge(config.SquidIntegratorID)
	log.Println("✅ Squid bridge initialized (public integrator ID)")

	socketBridge := NewSocketBridge(config.SocketAPIKey)
	log.Println("✅ Socket bridge initialized (public demo key)")

	mayanBridge := NewMayanBridge()
	log.Println("✅ Mayan bridge initialized (no key needed)")

	// Initialize wallet manager
	walletManager, err := NewWalletManager(config)
	if err != nil {
		log.Printf("⚠️  Wallet manager initialization failed: %v", err)
	} else {
		walletManager.LogWalletInfo()
	}

	// Use wallet addresses from config if set
	solAddress := config.WalletSOLAddress
	evmAddress := config.WalletEVMAddress

	// Fallback to defaults for quote-only mode
	if solAddress == "" {
		solAddress = "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK"
	}
	if evmAddress == "" {
		evmAddress = "0x867A784039D4842A32Ddd1277729Ad1373301458"
	}

	// Initialize balance checker
	var balanceChecker *BalanceChecker
	if config.MobulaAPIKey != "" {
		balanceChecker = NewBalanceChecker(config.MobulaAPIKey, evmAddress, solAddress)
		log.Println("✅ Balance checker initialized")

		// Print initial balances
		balanceChecker.PrintBalances()
	}

	// Initialize Slack notifier
	var slackNotifier *SlackNotifier
	if config.SlackWebhookURL != "" {
		slackNotifier = NewSlackNotifier(
			config.SlackWebhookURL,
			config.MobulaAPIKey,
			evmAddress,
			solAddress,
		)
		log.Println("✅ Slack notifications enabled")
	}

	// Initialize executor for execution mode
	var executor *Executor
	if config.ExecutionMode != "" {
		execConfig := &ExecutionConfig{
			Mode:             ExecutionMode(config.ExecutionMode),
			Freq5USD:         config.Freq5USD,
			Freq50USD:        config.Freq50USD,
			Freq300USD:       config.Freq300USD,
			EnableDebridge:   config.EnableDebridge,
			MaxDailySpendUSD: config.MaxDailySpendUSD,
		}

		executor = NewExecutor(
			execConfig,
			walletManager,
			balanceChecker,
			mobulaBridge,
			relayBridge,
			lifiBridge,
			debridgeBridge,
			config.MonitorRegion,
			slackNotifier,
		)

		// Validate setup
		if err := executor.ValidateSetup(); err != nil {
			log.Printf("⚠️  Executor validation failed: %v", err)
		} else {
			// Print execution plan and cost estimate
			executor.PrintExecutionPlan()
			executor.EstimateMonthlyCost()
		}
	}

	// Pre-seed the self-healing series so alerting rules match from startup.
	initSelfHealingMetrics()

	// Start Prometheus metrics endpoint. Railway / most PaaS inject $PORT
	// and route external traffic to whatever value they chose. If we bind
	// to the wrong port the edge proxy returns 502 with x-railway-fallback.
	// Honour $PORT first, then a manual METRICS_PORT override, then 9090.
	metricsPort := os.Getenv("PORT")
	if metricsPort == "" {
		metricsPort = os.Getenv("METRICS_PORT")
	}
	if metricsPort == "" {
		metricsPort = "9090"
	}
	go func() {
		http.Handle("/metrics", promhttp.Handler())

		// Health check endpoint
		http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("OK"))
		})

		// Status endpoint
		http.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			status := fmt.Sprintf(`{
				"mode": "%s",
				"evm_address": "%s",
				"sol_address": "%s",
				"debridge_enabled": %v,
				"region": "%s"
			}`, config.ExecutionMode, evmAddress, solAddress, config.EnableDebridge, config.MonitorRegion)
			w.Write([]byte(status))
		})

		// Live logs endpoint (last N lines from ring buffer). Requires LOG_TOKEN
		// env var as Bearer auth so we don't expose private keys / TXs publicly.
		// Usage: curl -H "Authorization: Bearer $LOG_TOKEN" https://.../logs?n=200
		http.HandleFunc("/logs", func(w http.ResponseWriter, r *http.Request) {
			token := os.Getenv("LOG_TOKEN")
			if token == "" {
				http.Error(w, "LOG_TOKEN env var not set on monitor — endpoint disabled", http.StatusServiceUnavailable)
				return
			}
			auth := r.Header.Get("Authorization")
			if auth != "Bearer "+token {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			n := 200
			if v := r.URL.Query().Get("n"); v != "" {
				if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
					n = parsed
				}
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			for _, line := range logRing.Snapshot(n) {
				_, _ = w.Write([]byte(line + "\n"))
			}
		})

		log.Printf("📊 Prometheus metrics server listening on :%s", metricsPort)
		if err := http.ListenAndServe(":"+metricsPort, nil); err != nil {
			log.Fatalf("Failed to start metrics server: %v", err)
		}
	}()

	// Wait for metrics server to start
	time.Sleep(2 * time.Second)

	// Test routes — call GetTestRoutes()/etc. fresh inside each loop iteration so
	// the TRUMP-denominated R4 amounts pick up live TRUMP price (5min cache).
	// Initial values used for the first quote run + dry-run / single-test only.
	allRoutes := GetTestRoutes()
	triangleRoutes := GetTriangleRoutes()

	log.Println("🔄 Starting monitoring loop (5 minute interval)...")

	// Send startup notification to Slack
	if slackNotifier != nil {
		if err := slackNotifier.NotifyStartup(config.ExecutionMode); err != nil {
			log.Printf("⚠️  Slack startup notification failed: %v", err)
		}
	}

	// Run quote tests immediately on startup (all routes)
	runQuoteTests(mobulaBridge, relayBridge, debridgeBridge, lifiBridge, acrossBridge, nearIntentsBridge, squidBridge, socketBridge, mayanBridge, allRoutes, config.MonitorRegion, solAddress, evmAddress)

	// If in dry-run mode, run a single dry-run test
	if config.ExecutionMode == "dry-run" && executor != nil {
		log.Println("\n🧪 Running DRY-RUN execution test (triangle routes)...")
		for _, route := range triangleRoutes {
			executor.RunDryRun(route, 5.0) // Test with $5
		}
	}

	// Single-test mode: run ONE real execution and exit. Uses the same sequential
	// per-bridge orchestration as production so dry-run matches real behaviour.
	if config.ExecutionMode == "single-test" && executor != nil {
		testAmount := config.TestAmountUSD
		if testAmount <= 0 {
			testAmount = 1.0
		}
		log.Printf("\n🧪 SINGLE-TEST MODE: $%.2f per bridge × 3 bridges × 3 routes = 9 TX", testAmount)
		log.Println("⚠️  This will execute REAL transactions!")

		bridges := []string{"mobula", "relay", "lifi"}
		execMu.Lock()
		for _, bridge := range bridges {
			log.Printf("\n━━━ Bridge: %s ━━━", bridge)
			for _, route := range triangleRoutes {
				log.Printf("  → %s", route.Name)
				executor.RunBridgeOnRoute(bridge, route, testAmount)
				time.Sleep(2 * time.Second)
			}
		}
		execMu.Unlock()

		log.Println("\n✅ Single-test complete! Exiting.")
		return
	}

	// Quote loop in its own goroutine, plus a per-cycle 4-minute timeout: even if
	// a bridge hangs past its individual http.Client timeout (TLS / DNS edge cases
	// where Go's per-request timeout doesn't fire), the cycle is abandoned so the
	// next tick still runs. The cycle keeps going in a child goroutine; we just
	// stop waiting on it.
	go func() {
		quoteTicker := time.NewTicker(5 * time.Minute)
		defer quoteTicker.Stop()
		for range quoteTicker.C {
			done := make(chan struct{})
			go func() {
				defer close(done)
				runQuoteTests(mobulaBridge, relayBridge, debridgeBridge, lifiBridge, acrossBridge, nearIntentsBridge, squidBridge, socketBridge, mayanBridge, GetTestRoutes(), config.MonitorRegion, solAddress, evmAddress)
			}()
			select {
			case <-done:
			case <-time.After(4 * time.Minute):
				log.Printf("⏱️  Quote cycle exceeded 4min — abandoning, next tick will retry")
			}
		}
	}()

	// Watchdog: if no log line has been written for 10 minutes, dump every
	// goroutine's stack trace to /logs (so we can see what was blocked AFTER
	// the panic-induced restart) then panic — Railway auto-restarts the
	// container on panic. Brute-force safety net for any freeze cause we
	// haven't pinned down (recurring 08:16 UTC freeze even after non-blocking
	// stdout fix). Also logs dropped-bytes counter every minute so we can tell
	// from /logs whether stdout backpressure is the issue.
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			age := logRing.LastWriteAge()
			dropped := logRing.DroppedBytes()
			if age > 10*time.Minute {
				log.Printf("🚨 WATCHDOG: no logs for %s (dropped=%d bytes) — dumping goroutines and panicking to force restart", age.Truncate(time.Second), dropped)
				buf := make([]byte, 1<<20) // 1MB
				n := runtime.Stack(buf, true)
				log.Printf("=== GOROUTINE DUMP (%d bytes) ===\n%s\n=== END DUMP ===", n, buf[:n])
				panic(fmt.Sprintf("watchdog: no log activity for %s", age))
			}
			log.Printf("🐶 watchdog ok — last log %s ago, stdout dropped %d bytes total", age.Truncate(time.Second), dropped)
		}
	}()

	// Start wallet balance refresh loop (every 5 min) so low-balance alerts can fire
	// well before the next scheduled execution.
	if balanceChecker != nil {
		if err := balanceChecker.ExportBalancesToMetrics(config.MonitorRegion); err != nil {
			log.Printf("⚠️  Initial balance export failed: %v", err)
		}
		balanceTicker := time.NewTicker(5 * time.Minute)
		go func() {
			for range balanceTicker.C {
				if err := balanceChecker.ExportBalancesToMetrics(config.MonitorRegion); err != nil {
					log.Printf("⚠️  Balance export failed: %v", err)
				}
			}
		}()

		// Daily 09:30 UTC cron: diff today vs yesterday's wallet, post delta to Slack.
		StartDailyPnLCron(balanceChecker, slackNotifier)
	}

	// Start execution scheduler with fixed UTC times (survives redeploys).
	// Set BENCHMARK_PAUSED=true to skip scheduler init while keeping quote loop +
	// watchdog active — used when bridge providers have ongoing bugs we don't want
	// to keep firing real TX into (e.g. Mobula SOL-drain bug).
	var scheduler *Scheduler
	paused := strings.EqualFold(strings.TrimSpace(os.Getenv("BENCHMARK_PAUSED")), "true")
	if paused {
		log.Println("⏸️  BENCHMARK_PAUSED=true — execution scheduler disabled. Quote loop + watchdog continue.")
	} else if config.ExecutionMode == "production" && executor != nil {
		scheduler = NewScheduler(DefaultSchedule())
		scheduler.Start()
		log.Println("🚀 Production mode: fixed-time scheduler started")
	}

	// Auto-rebalancer shares the executor's quote and broadcast plumbing. Inert
	// unless the executor can actually broadcast (production mode, keys present),
	// so it costs nothing in dry-run or while paused.
	var rebalancer *Rebalancer
	var gasTopper *GasTopper
	if executor != nil {
		rebalancer = NewRebalancer(executor, slackNotifier)
		gasTopper = NewGasTopper(executor, slackNotifier)
	}

	// Stuck-fund reaper: gauges in every mode (alerting must survive a pause),
	// corrective transfers only in production and unpaused.
	StartReaper(balanceChecker, rebalancer, slackNotifier, config.ExecutionMode, paused)

	// Track last meme execution day to run weekly
	lastMemeDay := -1

	// Main loop — scheduler-only (quote loop now lives in its own goroutine).
	for {
		select {
		case <-getSchedulerChan(scheduler, "$5"):
			// $5 execution loop - daily at 10:00 UTC
			if executor != nil && config.ExecutionMode == "production" {
				runTierIfViable(executor, balanceChecker, slackNotifier, rebalancer, gasTopper, GetTriangleRoutes(), 5.0, "daily")

				// Meme routes use independent capital (TRUMP) — always attempt,
				// the per-route RunReal check catches insufficient TRUMP.
				now := time.Now().UTC()
				if now.Weekday() == time.Monday && now.YearDay() != lastMemeDay {
					log.Println("💸 Running $5 meme execution tests (weekly)...")
					execMu.Lock()
					for _, route := range GetMemeRoutes() {
						executor.RunReal(route, 5.0)
					}
					execMu.Unlock()
					lastMemeDay = now.YearDay()
				}
			}

		case <-getSchedulerChan(scheduler, "$50"):
			if executor != nil && config.ExecutionMode == "production" {
				runTierIfViable(executor, balanceChecker, slackNotifier, rebalancer, gasTopper, GetTriangleRoutes(), 50.0, "Mon+Thu")
			}

		case <-getSchedulerChan(scheduler, "$300"):
			if executor != nil && config.ExecutionMode == "production" {
				runTierIfViable(executor, balanceChecker, slackNotifier, rebalancer, gasTopper, GetTriangleRoutes(), 300.0, "Mon weekly")
			}
		}
	}
}

// downgradeLadder returns the tier amounts to try, largest first, starting at
// the scheduled tier. Partial data beats none: if $300 cannot run we still
// want the $50 or $5 datapoint from the same slot.
func downgradeLadder(tier float64) []float64 {
	all := []float64{300, 50, 5}
	var out []float64
	for _, t := range all {
		if t <= tier {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		out = []float64{tier}
	}
	return out
}

// runTierIfViable pre-flights the full R1→R2→R3 cycle at the given tier. If the
// simulation says the cycle cannot complete, it first lets the auto-rebalancer
// try to unblock the tier, then walks the downgrade ladder to a smaller amount.
// Only if nothing on the ladder is viable does it emit ONE Slack "couldn't run"
// message and skip, so the next scheduler tick retries. Returns true if any
// amount actually ran.
func runTierIfViable(executor *Executor, bc *BalanceChecker, slack *SlackNotifier,
	rebalancer *Rebalancer, gasTopper *GasTopper, routes []TestRoute, tier float64, tierLabel string,
) bool {
	if bc == nil {
		log.Printf("⚠️  No balance checker — skipping tier $%.0f pre-flight", tier)
		return false
	}

	// Single-flight: this slot owns the wallets end to end (gas top-up,
	// corrective rebalances, triangle runs). The reaper TryLocks and skips
	// its corrective action while this is held.
	execMu.Lock()
	defer execMu.Unlock()

	ladder := downgradeLadder(tier)
	blockedReason := ""

	// ONE corrective-transfer budget for the whole scheduler slot, shared by
	// every ladder rung. Without sharing, each rung consumed its own attempt
	// counter and a single slot could broadcast up to six transfers.
	budget := newSlotBudget()

	for i, amount := range ladder {
		balances, degraded, err := bc.GetAllBalancesDetailed()
		if err != nil || degraded {
			// Unreadable is not the same as empty: refuse to act (and above all
			// refuse to rebalance) on balances we cannot trust.
			log.Printf("⚠️  Pre-flight balances unreadable for $%.0f tier (degraded=%v err=%v)", tier, degraded, err)
			if slack != nil {
				_ = slack.NotifyTierSkipped(tier, tierLabel,
					fmt.Sprintf("Balances unreadable (degraded=%v, err=%v). Refusing to run or rebalance blind.", degraded, err))
			}
			return false
		}

		// Gas check at every rung: the tier guard uses the rung amount, so a
		// smaller tier may unlock a top-up that $300 could not afford. A chain
		// with blocked gas will fail the TX anyway — skip the rung cleanly.
		if !gasTopper.CheckAndTopUp(balances, amount) {
			log.Printf("Tier $%.0f skipped: gas blocked on at least one triangle chain", amount)
			if blockedReason == "" {
				blockedReason = "insufficient native gas after top-up attempt"
			}
			continue
		}

		sim := SimulateTriangleCycle(balances, amount)
		if !sim.Viable && rebalancer != nil {
			sim, _ = rebalancer.TryUnblockTier(sim, balances, tierLabel, budget)
		}
		if !sim.Viable {
			if blockedReason == "" {
				blockedReason = sim.Reason
			}
			log.Printf("⏭️  Tier $%.0f not viable at $%.0f: %s", tier, amount, sim.Reason)
			continue
		}

		if i > 0 {
			log.Printf("⬇️  Tier $%.0f downgraded to $%.0f: %s", tier, amount, blockedReason)
			bridgeTierDowngraded.WithLabelValues(tierAmountLabel(tier), tierAmountLabel(amount)).Set(1)
			if slack != nil {
				_ = slack.NotifyTierDowngrade(tier, amount, blockedReason)
			}
		} else {
			// The scheduled tier runs at full size again: clear its downgrade
			// gauges so the alert stops firing.
			for _, smaller := range ladder[1:] {
				bridgeTierDowngraded.WithLabelValues(tierAmountLabel(tier), tierAmountLabel(smaller)).Set(0)
			}
		}

		runTriangle(executor, routes, amount)
		return true
	}

	log.Printf("⏭️  Tier $%.0f skipped entirely: %s", tier, blockedReason)
	if slack != nil {
		_ = slack.NotifyTierSkipped(tier, tierLabel, blockedReason)
	}
	return false
}

func tierAmountLabel(tier float64) string {
	return strconv.FormatFloat(tier, 'f', 0, 64)
}

// runTriangle runs the sequential per-bridge orchestration: each bridge runs a
// full R1→R2→R3 triangle before the next bridge starts. Halves the peak capital
// need per leg, gives a clean round-trip cost per provider, and unlocks larger
// tiers with less capital.
func runTriangle(executor *Executor, routes []TestRoute, tier float64) {
	log.Printf("💸 Running $%.0f triangle (sequential per-bridge)...", tier)
	bridges := []string{"mobula", "relay", "lifi"}
	for _, bridge := range bridges {
		log.Printf("  ── Bridge %s full triangle ──", bridge)
		for i, route := range routes {
			result := executor.RunBridgeOnRoute(bridge, route, tier)
			time.Sleep(2 * time.Second)

			// Cascade-stop: if a route in this bridge's triangle fails (broadcast
			// error, revert, or refund), the next route's source leg won't have
			// been replenished by the previous one's settlement. Skip the rest
			// of this bridge's triangle to avoid forced reverts and 5min timeouts.
			if result == nil || !result.Success {
				log.Printf("  ⚠️  %s route %d (%s) failed — skipping remaining %s routes (cascade prevention)",
					bridge, i+1, route.Name, bridge)
				break
			}
		}
	}
}

// getSchedulerChan returns the appropriate scheduler channel or nil
func getSchedulerChan(s *Scheduler, amount string) <-chan struct{} {
	if s == nil {
		return nil
	}
	switch amount {
	case "$5":
		return s.Exec5Chan()
	case "$50":
		return s.Exec50Chan()
	case "$300":
		return s.Exec300Chan()
	}
	return nil
}

// All our source tokens (USDC, USDT, TRUMP) use 6 decimals.
const tokenDecimals = 6

func toRawUnits(amount float64) string {
	raw := amount * math.Pow10(tokenDecimals)
	return strconv.FormatInt(int64(math.Round(raw)), 10)
}

// runQuoteTests runs quote-only tests (FREE, no execution)
func runQuoteTests(
	mobulaBridge *MobulaBridge,
	relayBridge *RelayBridge,
	debridgeBridge *DebridgeBridge,
	lifiBridge *LiFiBridge,
	acrossBridge *AcrossBridge,
	nearIntentsBridge *NearIntentsBridge,
	squidBridge *SquidBridge,
	socketBridge *SocketBridge,
	mayanBridge *MayanBridge,
	routes []TestRoute, region, solAddress, evmAddress string,
) {
	timestamp := time.Now().Format("2006-01-02 15:04:05")
	log.Printf("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	log.Printf("⏰ Quote Test Run: %s", timestamp)
	log.Printf("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")

	for _, route := range routes {
		for i, amount := range route.Amounts {
			amountUsd := amount
			if i < len(route.UsdAmounts) {
				amountUsd = route.UsdAmounts[i]
			}
			rawUnits := toRawUnits(amount)

			if mobulaBridge != nil {
				mobulaBridge.TestRoute(route, amount, amountUsd, region, solAddress, evmAddress)
				time.Sleep(500 * time.Millisecond)
			}
			relayBridge.TestRoute(route, amount, amountUsd, rawUnits, region, solAddress, evmAddress)
			time.Sleep(500 * time.Millisecond)

			// Debridge doesn't support HyperCore (chain not in their whitelist) —
			// skip cleanly to avoid spamming bridge_errors_total{error_type="quote_failed"}.
			if route.ToChain != "HyperCore" {
				debridgeBridge.TestRoute(route, amount, amountUsd, rawUnits, region)
				time.Sleep(500 * time.Millisecond)
			}

			lifiBridge.TestRoute(route, amount, amountUsd, rawUnits, region, solAddress, evmAddress)
			time.Sleep(500 * time.Millisecond)

			// Across covers the Sol/Base/Arb stablecoin corridors via the
			// keyless Swap API (cross-asset legs included). HyperCore and the
			// TRUMP calibration route return early inside TestRoute without
			// emitting metrics, so coverage gaps stay honest.
			acrossBridge.TestRoute(route, amount, amountUsd, rawUnits, region, solAddress, evmAddress)
			time.Sleep(500 * time.Millisecond)

			// Near Intents covers Sol/Base/Arb USDC bi-directionally and HyperCore
			// as destination only. Sources outside that set return early inside
			// TestRoute without emitting metrics, so the bench-fee bucket stays
			// honest (no fake unsupported-route failures).
			nearIntentsBridge.TestRoute(route, amount, amountUsd, rawUnits, region, solAddress, evmAddress)
			time.Sleep(500 * time.Millisecond)

			// Squid Router (Axelar): EVM-only (Base/Arb). Solana source returns
			// server-side 500 — TestRoute returns early for unsupported corridors.
			squidBridge.TestRoute(route, amount, amountUsd, rawUnits, region, solAddress, evmAddress)
			time.Sleep(500 * time.Millisecond)

			// Socket Protocol (Bungee): EVM-only aggregator (Base/Arb).
			// Returns best-output route across Across, Stargate, CCTP, etc.
			socketBridge.TestRoute(route, amount, amountUsd, rawUnits, region, solAddress, evmAddress)
			time.Sleep(500 * time.Millisecond)

			// Mayan Finance: Solana-EVM only. TestRoute returns early for pure
			// EVM corridors. May emit ROUTE_NOT_FOUND on some corridors during
			// API outages; harness records those as quote_failed so success rate
			// reflects availability rather than latency.
			mayanBridge.TestRoute(route, amount, amountUsd, rawUnits, region, solAddress, evmAddress)
			time.Sleep(500 * time.Millisecond)
		}
	}

	log.Println("")
}
