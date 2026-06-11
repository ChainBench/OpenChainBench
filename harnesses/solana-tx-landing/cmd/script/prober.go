package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/gagliardetto/solana-go/programs/memo"
	"github.com/gagliardetto/solana-go/programs/system"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/gagliardetto/solana-go/rpc/ws"
)

// Active prober — submits a synthetic mainnet tx through each landing
// service every cycle, then polls confirmation. Headline metrics =
// landing_rate + p50/p99 latency per service. Methodology pinned at
// OpenChainBench/docs/methodology/solana-tx-landing-active.md.
//
// The prober is OPT-IN. It only runs when SOLANA_PROBE_KEYPAIR_BASE58
// is set; absence keeps the harness in pure observational mode.

// Public Solana mainnet RPC used for state reads (blockhash, slot,
// balance, sig statuses). NOT used for tx submission — each service
// has its own write endpoint (see senders.go).
const defaultSolanaRPC = "https://api.mainnet-beta.solana.com"

// Note: defaultSolanaWS is declared in subscriber.go (shared with the
// observational logsSubscribe path). The prober uses the same default
// for signatureSubscribe but lets SOLANA_PROBE_WS_URL override it
// independently of the observational subscription endpoint.

// Default V0-Lean cadence per methodology. Override with
// SOLANA_PROBE_INTERVAL (Go time.Duration, e.g. "30m", "1h").
const defaultProbeInterval = 60 * time.Minute

// Confirmation observation. Primary path is `signatureSubscribe` via
// WebSocket — the RPC pushes a notification the instant the tx reaches
// the requested commitment, so resolution is bounded only by network
// RTT (~30-50 ms us-east → mainnet-beta) and not by client polling.
// Fallback if the WS connection fails: HTTP polling of
// `getSignatureStatuses` at probePollInterval cadence. 60 s ceiling
// either way; beyond that we classify as dropped{reason=timeout}.
//
// 200 ms poll fallback chosen because Solana slot duration is ~400 ms
// and "confirmed" lands ~1-2 slots after inclusion; the WS path is
// faster but the fallback still differentiates services in the 400-
// 2000 ms zone where they actually compete.
const (
	probePollInterval = 200 * time.Millisecond
	probeTimeout      = 60 * time.Second
)

// Minimum keypair balance (lamports) we require before running a
// cycle. Below this the bench would bias against high-tip services
// (which deplete the keypair fastest) — better to skip and alert.
// Covers: 5 services × ~600k lamports avg tip + 5 × 5k base fee +
// 5 × 2.5k priority + a 10× safety multiplier = ~30M lamports.
const minProbeBalanceLamports uint64 = 30_000_000 // 0.03 SOL

// Compute-budget knobs frozen by methodology §3. Changing them is a
// PR-with-14-day-window event.
const (
	probeComputeUnitLimit = 50_000
	probeComputeUnitPrice = 50_000 // micro-lamports per CU
)

// runProber is the goroutine entry. Returns when ctx is cancelled.
// Mirrors the runSubscriber() launch pattern in main.go.
func runProber(ctx context.Context) {
	cfg, err := loadProberConfig()
	if err != nil {
		fmt.Printf("[prober] disabled: %v\n", err)
		// Region label is unknown here; emit a single "us-east"=0
		// gauge so dashboards default-zeroed. Operators redeploying
		// from a different region should update the env var and the
		// metric flips on next start.
		solanaLandingProbeEnabled.WithLabelValues(envDefault("SOLANA_PROBE_REGION", "us-east")).Set(0)
		return
	}
	fmt.Printf("[prober] enabled — region=%s wallet=%s interval=%s services=%d\n",
		cfg.Region, cfg.Keypair.PublicKey().String(), cfg.Interval, len(cfg.Probes))
	for _, p := range cfg.Probes {
		fmt.Printf("  · %-12s mode=%-12s tip=%d lamports endpoint=%s\n",
			p.Service, p.Mode, p.TipLamports, sanitizeEndpoint(p.Endpoint))
	}
	solanaLandingProbeEnabled.WithLabelValues(cfg.Region).Set(1)

	rpcClient := rpc.New(cfg.ReadRPCURL)

	// Fire the first cycle ~5s after startup so metrics show up
	// quickly; subsequent cycles run on the configured interval.
	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()
	warmup := time.NewTimer(5 * time.Second)
	defer warmup.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-warmup.C:
			runProbeCycle(ctx, cfg, rpcClient)
		case <-ticker.C:
			runProbeCycle(ctx, cfg, rpcClient)
		}
	}
}

// runProbeCycle fires one probe per configured service in parallel,
// then emits the cycle-complete metrics regardless of individual
// outcomes. Each per-service goroutine updates its own metrics.
func runProbeCycle(ctx context.Context, cfg *proberConfig, rpcClient *rpc.Client) {
	if ctx.Err() != nil {
		return
	}
	cycleStart := time.Now()
	cycleID := newCycleID()

	// Refresh keypair balance gauge once per cycle. Skip the rest of
	// the cycle if balance is below safety threshold — running probes
	// with insufficient balance would bias the bench against premium-
	// tip services first (see methodology §10).
	var keypairLamports uint64
	func() {
		balCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		bal, err := rpcClient.GetBalance(balCtx, cfg.Keypair.PublicKey(), rpc.CommitmentConfirmed)
		if err == nil && bal != nil {
			keypairLamports = bal.Value
			solanaLandingProbeKeypairBalanceSOL.WithLabelValues(cfg.Region).
				Set(float64(bal.Value) / 1e9)
		}
	}()
	if keypairLamports > 0 && keypairLamports < minProbeBalanceLamports {
		fmt.Printf("[prober] cycle %s SKIPPED — keypair balance %d lamports < threshold %d\n",
			cycleID, keypairLamports, minProbeBalanceLamports)
		solanaLandingProbeKeypairLowBalanceTotal.WithLabelValues(cfg.Region).Inc()
		solanaLandingProbeCycleTotal.WithLabelValues(cfg.Region).Inc()
		solanaLandingProbeLastCycleTimestamp.WithLabelValues(cfg.Region).
			Set(float64(time.Now().Unix()))
		return
	}

	// Fetch blockhash + submit_slot ONCE per cycle so every service
	// shares the same chain-state reference (methodology §4).
	// Commitment = processed → freshest blockhash, lowest expiry risk.
	bhCtx, bhCancel := context.WithTimeout(ctx, 5*time.Second)
	bhResp, err := rpcClient.GetLatestBlockhash(bhCtx, rpc.CommitmentProcessed)
	bhCancel()
	if err != nil {
		fmt.Printf("[prober] cycle %s blockhash error: %v\n", cycleID, err)
		solanaLandingProbeCycleTotal.WithLabelValues(cfg.Region).Inc()
		solanaLandingProbeLastCycleTimestamp.WithLabelValues(cfg.Region).
			Set(float64(time.Now().Unix()))
		return
	}
	blockhash := bhResp.Value.Blockhash

	slotCtx, slotCancel := context.WithTimeout(ctx, 3*time.Second)
	submitSlot, err := rpcClient.GetSlot(slotCtx, rpc.CommitmentProcessed)
	slotCancel()
	if err != nil {
		fmt.Printf("[prober] cycle %s submit_slot error: %v\n", cycleID, err)
		// We can still send — just lose the slot-delta metric on this
		// cycle. Fall through with submitSlot=0; metric handler skips
		// the slot histogram emission when submitSlot==0.
	}

	// Open a single WS client per cycle for signatureSubscribe. All
	// per-service probes share it (gagliardetto/solana-go ws.Client is
	// safe for concurrent subscriptions). If the connect fails we fall
	// back to HTTP polling for every probe — same methodology floor as
	// before the WS path was introduced, just with a quantization
	// penalty of ~probePollInterval.
	wsCtx, wsCancel := context.WithTimeout(ctx, 5*time.Second)
	wsClient, wsErr := ws.Connect(wsCtx, cfg.ReadWSURL)
	wsCancel()
	if wsErr != nil {
		fmt.Printf("[prober] cycle %s WS connect failed: %v — falling back to %s polling\n",
			cycleID, wsErr, probePollInterval)
		wsClient = nil
	}
	defer func() {
		if wsClient != nil {
			wsClient.Close()
		}
	}()

	// Fan out — one goroutine per (service, mode). Each one returns a
	// ProbeResult via the channel so we can build a per-cycle summary
	// (for Slack notification + future log aggregations).
	results := make(chan ProbeResult, len(cfg.Probes))
	var wg sync.WaitGroup
	for _, probe := range cfg.Probes {
		wg.Add(1)
		go func(p serviceProbe) {
			defer wg.Done()
			results <- runSingleProbe(ctx, cfg, rpcClient, wsClient, p, blockhash, submitSlot, cycleID)
		}(probe)
	}
	wg.Wait()
	close(results)

	collected := make([]ProbeResult, 0, len(cfg.Probes))
	for r := range results {
		collected = append(collected, r)
	}

	duration := time.Since(cycleStart)
	solanaLandingProbeCycleTotal.WithLabelValues(cfg.Region).Inc()
	solanaLandingProbeLastCycleTimestamp.WithLabelValues(cfg.Region).
		Set(float64(time.Now().Unix()))
	fmt.Printf("[prober] cycle %s done in %s\n", cycleID, duration.Round(time.Millisecond))

	// Optional Slack notification (opt-in via SLACK_WEBHOOK_URL).
	// Non-blocking — Slack failures are logged but don't affect probes.
	if cfg.SlackWebhookURL != "" {
		summary := cycleSummary{
			CycleID:         cycleID,
			Region:          cfg.Region,
			Duration:        duration,
			KeypairLamports: keypairLamports,
			SubmitSlot:      submitSlot,
			Results:         collected,
		}
		if err := postCycleToSlack(ctx, cfg.SlackWebhookURL, summary); err != nil {
			fmt.Printf("[prober] slack post failed: %s\n", scrubSecrets(err.Error()))
		}
	}
}

// runSingleProbe builds + signs + sends + polls for one service.
// Returns a ProbeResult (consumed by runProbeCycle for the Slack
// summary). Wrapped in recover() so a panic in any single service
// doesn't kill the whole prober — the bad probe just counts as
// invalid and the cycle continues.
func runSingleProbe(
	ctx context.Context,
	cfg *proberConfig,
	rpcClient *rpc.Client,
	wsClient *ws.Client,
	p serviceProbe,
	blockhash solana.Hash,
	submitSlot uint64,
	cycleID string,
) (result ProbeResult) {
	result = ProbeResult{
		Service:     p.Service,
		Mode:        p.Mode,
		TipLamports: p.TipLamports,
		SubmitSlot:  submitSlot,
	}
	labels := []string{string(p.Service), p.Mode, cfg.Region}

	defer func() {
		if r := recover(); r != nil {
			fmt.Printf("[prober][%s/%s] PANIC recovered: %v\n", p.Service, p.Mode, r)
			solanaLandingProbeDropped.WithLabelValues(append(append([]string{}, labels...), "invalid")...).Inc()
			result.Landed = false
			result.DropReason = "invalid"
			result.ErrorMsg = fmt.Sprintf("panic: %v", r)
		}
	}()

	tx, err := buildProbeTx(cfg.Keypair, p, blockhash, cycleID)
	if err != nil {
		fmt.Printf("[prober][%s/%s] build tx: %v\n", p.Service, p.Mode, err)
		solanaLandingProbeDropped.WithLabelValues(append(labels, "invalid")...).Inc()
		result.DropReason = "invalid"
		result.ErrorMsg = sanitizeError(err)
		return
	}
	if err := signTx(tx, cfg.Keypair); err != nil {
		fmt.Printf("[prober][%s/%s] sign: %v\n", p.Service, p.Mode, err)
		solanaLandingProbeDropped.WithLabelValues(append(labels, "invalid")...).Inc()
		result.DropReason = "invalid"
		result.ErrorMsg = sanitizeError(err)
		return
	}

	// Subscribe to the signature BEFORE submitting. If we waited until
	// after submit, a fast confirmation (<RTT to WS endpoint) could fire
	// and complete before our subscription was registered — we'd miss
	// the event and fall through to the 60 s timeout. Subscribing first
	// guarantees the validator buffers any matching state transition for
	// our active subscription.
	sig := tx.Signatures[0]
	var sigSub *ws.SignatureSubscription
	if wsClient != nil {
		sub, subErr := wsClient.SignatureSubscribe(sig, rpc.CommitmentConfirmed)
		if subErr != nil {
			// Sub failure for one probe shouldn't kill the cycle. Log
			// and fall through to HTTP polling for this probe.
			fmt.Printf("[prober][%s/%s] WS sub failed: %v (falling back to polling)\n",
				p.Service, p.Mode, subErr)
		} else {
			sigSub = sub
			defer sigSub.Unsubscribe()
		}
	}

	wallStart := time.Now()
	sigStr, err := p.Sender(ctx, tx)
	if err != nil {
		reason := classifyDropReason(err)
		fmt.Printf("[prober][%s/%s] submit: %s (reason=%s)\n",
			p.Service, p.Mode, sanitizeError(err), reason)
		solanaLandingProbeDropped.WithLabelValues(append(labels, reason)...).Inc()
		result.DropReason = reason
		result.ErrorMsg = sanitizeError(err)
		return
	}
	result.Signature = sigStr

	var landed bool
	var landSlot uint64
	var pollErr error
	if sigSub != nil {
		landed, landSlot, pollErr = awaitSignatureViaWS(ctx, sigSub, probeTimeout)
	} else {
		landed, landSlot, pollErr = pollSignatureStatus(ctx, rpcClient, sig)
	}
	wallMs := time.Since(wallStart).Milliseconds()
	result.WallMs = wallMs

	if pollErr != nil {
		fmt.Printf("[prober][%s/%s] poll err: %s (sig=%s)\n",
			p.Service, p.Mode, sanitizeError(pollErr), sigStr)
		solanaLandingProbeDropped.WithLabelValues(append(labels, "invalid")...).Inc()
		result.DropReason = "invalid"
		result.ErrorMsg = sanitizeError(pollErr)
		return
	}
	if !landed {
		solanaLandingProbeDropped.WithLabelValues(append(labels, "timeout")...).Inc()
		result.DropReason = "timeout"
		return
	}

	solanaLandingProbeSuccess.WithLabelValues(labels...).Inc()
	solanaLandingProbeLatencyMs.WithLabelValues(labels...).Set(float64(wallMs))
	solanaLandingProbeLatencyMsHistogram.WithLabelValues(labels...).Observe(float64(wallMs))

	result.Landed = true
	result.LandSlot = landSlot
	if submitSlot > 0 && landSlot >= submitSlot {
		slotDelta := float64(landSlot - submitSlot)
		solanaLandingProbeLatencySlots.WithLabelValues(labels...).Set(slotDelta)
		solanaLandingProbeLatencySlotsHistogram.WithLabelValues(labels...).Observe(slotDelta)
		result.SlotDelta = int64(landSlot - submitSlot)
	}
	return
}

// buildProbeTx assembles the canonical probe payload per methodology
// §3. Three classes of instruction, in order: compute budget, payload
// self-transfer + service tip, memo.
func buildProbeTx(
	payer solana.PrivateKey,
	p serviceProbe,
	blockhash solana.Hash,
	cycleID string,
) (*solana.Transaction, error) {
	payerPub := payer.PublicKey()

	cuLimit := computebudget.NewSetComputeUnitLimitInstructionBuilder().
		SetUnits(probeComputeUnitLimit).Build()
	cuPrice := computebudget.NewSetComputeUnitPriceInstructionBuilder().
		SetMicroLamports(probeComputeUnitPrice).Build()

	// Self-transfer of 1 lamport: the minimum valid state-touching tx.
	payloadIx := system.NewTransferInstruction(1, payerPub, payerPub).Build()
	// Tip to the service's known on-chain tip wallet.
	tipIx := system.NewTransferInstruction(p.TipLamports, payerPub, p.TipWallet).Build()

	// Memo carries cycle ID + service + 8-byte random hex (forensic
	// trace on-chain). Keep it short — memo program charges per byte.
	memoText := fmt.Sprintf("ocb-%s-%s-%s", cycleID, p.Service, p.Mode)
	memoIx := memo.NewMemoInstructionBuilder().
		SetMessage([]byte(memoText)).
		SetSigner(payerPub).
		Build()

	tx, err := solana.NewTransaction(
		[]solana.Instruction{cuLimit, cuPrice, payloadIx, tipIx, memoIx},
		blockhash,
		solana.TransactionPayer(payerPub),
	)
	if err != nil {
		return nil, fmt.Errorf("build tx: %w", err)
	}
	return tx, nil
}

// signTx attaches the payer signature in-place. We expect exactly one
// signer (the prober keypair).
func signTx(tx *solana.Transaction, payer solana.PrivateKey) error {
	payerPub := payer.PublicKey()
	_, err := tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(payerPub) {
			return &payer
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}
	if len(tx.Signatures) == 0 {
		return fmt.Errorf("no signature attached")
	}
	return nil
}

// awaitSignatureViaWS blocks until the WS subscription delivers a
// signatureNotification or the timeout fires. The subscription must
// have been registered BEFORE the tx was submitted (otherwise a fast
// confirmation may complete before we listen, and we'd timeout
// spuriously). Returns the same (landed, land_slot, err) contract as
// pollSignatureStatus so the caller doesn't care which path ran.
func awaitSignatureViaWS(
	ctx context.Context,
	sub *ws.SignatureSubscription,
	timeout time.Duration,
) (bool, uint64, error) {
	recvCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	got, err := sub.Recv(recvCtx)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) ||
			errors.Is(err, context.Canceled) {
			return false, 0, nil
		}
		return false, 0, err
	}
	if got == nil {
		return false, 0, nil
	}
	if got.Value.Err != nil {
		return false, got.Context.Slot, fmt.Errorf("tx onchain error: %v", got.Value.Err)
	}
	return true, got.Context.Slot, nil
}

// pollSignatureStatus polls the public RPC every probePollInterval up
// to probeTimeout. Returns (true, land_slot, nil) when the tx reaches
// confirmed/finalized, (false, 0, nil) on timeout, or (_, _, err) on
// transport / on-chain failure.
func pollSignatureStatus(
	ctx context.Context,
	client *rpc.Client,
	sig solana.Signature,
) (bool, uint64, error) {
	deadline := time.Now().Add(probeTimeout)
	ticker := time.NewTicker(probePollInterval)
	defer ticker.Stop()

	for {
		if time.Now().After(deadline) {
			return false, 0, nil
		}
		select {
		case <-ctx.Done():
			return false, 0, ctx.Err()
		case <-ticker.C:
			qCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			out, err := client.GetSignatureStatuses(qCtx, false, sig)
			cancel()
			if err != nil {
				// Transport error — keep polling, the next tick may
				// succeed. Bail only on deadline.
				continue
			}
			if out == nil || len(out.Value) == 0 || out.Value[0] == nil {
				continue
			}
			st := out.Value[0]
			if st.Err != nil {
				return false, st.Slot, fmt.Errorf("tx onchain error: %v", st.Err)
			}
			switch st.ConfirmationStatus {
			case rpc.ConfirmationStatusConfirmed,
				rpc.ConfirmationStatusFinalized:
				return true, st.Slot, nil
			}
		}
	}
}

// classifyDropReason maps a sender error to one of {timeout, invalid,
// network_error, rate_limited}. Conservative — anything not clearly
// transport or rate-limit falls to "invalid".
func classifyDropReason(err error) string {
	if err == nil {
		return "invalid"
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "rate limit"),
		strings.Contains(msg, "too many requests"),
		strings.Contains(msg, "http 419"),
		strings.Contains(msg, "http 429"),
		strings.Contains(msg, "rpc error 419"),
		strings.Contains(msg, "rpc error 429"),
		strings.Contains(msg, "rpc error -32005"): // node behind / over quota
		return "rate_limited"
	case strings.Contains(msg, "timeout"),
		strings.Contains(msg, "deadline"),
		strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "no such host"),
		strings.Contains(msg, "eof"):
		return "network_error"
	default:
		return "invalid"
	}
}

// newCycleID returns an 8-byte hex string used as a forensic ID on
// the memo program instruction. Short enough to keep memo fees low.
func newCycleID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// sanitizeEndpoint masks any API key query param for safe log output.
func sanitizeEndpoint(s string) string {
	for _, secret := range []string{"api-key=", "?c=", "api_key="} {
		if i := strings.Index(s, secret); i >= 0 {
			return s[:i+len(secret)] + "***"
		}
	}
	return s
}

// sanitizeError scrubs known secret patterns from an error message.
// Upstream services sometimes echo the request URL or auth header in
// 4xx error bodies — our `postJSONRPC` includes the response body in
// the returned error. We re-scrub at log time.
func sanitizeError(err error) string {
	if err == nil {
		return ""
	}
	return sanitizeEndpoint(err.Error())
}

// proberConfig carries the loaded probe set. Built once at startup
// from env vars (loadProberConfig). Immutable for the process
// lifetime — methodology changes require a redeploy.
type proberConfig struct {
	Region          string
	Interval        time.Duration
	Keypair         solana.PrivateKey
	ReadRPCURL      string
	ReadWSURL       string
	Probes          []serviceProbe
	SlackWebhookURL string // optional — opt-in cycle reporter
}

// serviceProbe is one (service, mode) combination ready to fire.
type serviceProbe struct {
	Service     Service
	Mode        string             // "default" or "swqos_only" (Helius only)
	Endpoint    string             // full URL incl. any query params / auth
	TipWallet   solana.PublicKey
	TipLamports uint64
	Sender      func(ctx context.Context, tx *solana.Transaction) (string, error)
}

// loadProberConfig reads env vars and returns the configured probe
// set. Returns an error (which disables the prober) if the keypair is
// missing — by design, so an unconfigured Railway service stays in
// pure observational mode.
func loadProberConfig() (*proberConfig, error) {
	kpB58 := strings.TrimSpace(os.Getenv("SOLANA_PROBE_KEYPAIR_BASE58"))
	if kpB58 == "" {
		return nil, fmt.Errorf("SOLANA_PROBE_KEYPAIR_BASE58 not set")
	}
	kp, err := solana.PrivateKeyFromBase58(kpB58)
	if err != nil {
		return nil, fmt.Errorf("decode keypair: %w", err)
	}

	region := envDefault("SOLANA_PROBE_REGION", "us-east")
	rpcURL := envDefault("SOLANA_PROBE_RPC_URL", defaultSolanaRPC)
	wsURL := envDefault("SOLANA_PROBE_WS_URL", defaultSolanaWS)

	intervalStr := envDefault("SOLANA_PROBE_INTERVAL", defaultProbeInterval.String())
	interval, err := time.ParseDuration(intervalStr)
	if err != nil {
		return nil, fmt.Errorf("parse SOLANA_PROBE_INTERVAL=%q: %w", intervalStr, err)
	}

	enabled := parseEnabledServices(os.Getenv("SOLANA_PROBE_SERVICES"))
	probes, err := buildProbes(enabled)
	if err != nil {
		return nil, fmt.Errorf("build probes: %w", err)
	}
	if len(probes) == 0 {
		return nil, fmt.Errorf("no services configured (check API keys + SOLANA_PROBE_SERVICES)")
	}

	return &proberConfig{
		Region:          region,
		Interval:        interval,
		Keypair:         kp,
		ReadRPCURL:      rpcURL,
		ReadWSURL:       wsURL,
		Probes:          probes,
		SlackWebhookURL: strings.TrimSpace(os.Getenv("SLACK_WEBHOOK_URL")),
	}, nil
}

// parseEnabledServices accepts a comma-separated list of service
// slugs. Empty / unset = "all services attempted, gated by their
// individual API-key env var".
func parseEnabledServices(raw string) map[Service]bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil // nil = "every service if its key is present"
	}
	out := map[Service]bool{}
	for _, p := range strings.Split(raw, ",") {
		out[Service(strings.TrimSpace(p))] = true
	}
	return out
}

// envInt parses an int from env, falling back to def on missing /
// unparseable. Used by senders.go for per-service overrides.
func envInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
