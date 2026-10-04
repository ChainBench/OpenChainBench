package main

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ============================================================================
// OKX DEX head lag monitor
// ============================================================================
//
// OKX's Market API documents a `trades` channel on wss://wsdex.okx.com/ws/v6/dex
// that answers "Please log in" to every subscribe, and their fee table is
// explicit about why: the Free plan reads "WebSocket not supported", with the
// cheapest WS-capable plan at $99/month.
//
// The channel below is a different surface: the one their own web frontend
// holds, open with no credential. Two things made it hard to find and are worth
// writing down, because both produce silent failures:
//
//   - the channel is `dex-market-trade-history`, not any `trades` variant;
//   - the params go inside an `extraParams` JSON STRING. With flat
//     chainIndex/tokenContractAddress keys the server still answers
//     {"event":"subscribe"} and then pushes nothing at all. An ack proves
//     nothing here; only frames do.
//
// Undocumented frontend infrastructure, so it carries no stability guarantee.
// That is the same bet geckoterminal_monitor.go already makes in this harness
// (its pool ids are commented "extracted via reverse engineering"), and the
// failure mode is the same: the feed goes quiet, the watchdog purges the gauge,
// and the column reads "Feed down" rather than a wrong number.
//
// ---------------------------------------------------------------------------
// Why three chains and not four
// ---------------------------------------------------------------------------
//
// Every OKX timestamp is a whole second: 1,800 sampled across three chains,
// all ts%1000 == 0, and 938 of 938 again on BNB. A chain that publishes
// `head_lag_seconds` as receiveTime minus the provider's OWN timestamp would
// therefore publish our arithmetic as OKX's latency. That is the only
// constraint, and it is satisfied by reading a clock we own rather than
// theirs: Base takes the reference clock, Solana the race, and BNB joined
// referenceChains, which is what retired its exclusion here. The feed itself
// was never the obstacle: 938 trades in 45 s on chainId 56, all with a hash.
//
// Robinhood Chain is absent, and measured rather than read off their chain
// list: subscribing chainId 4663 for the bench's USDG and for the pool itself
// is ACKED both times and yields 0 trades in 40 s, while Base on the same
// socket delivered 267. That is the same ack-proves-nothing shape as the six
// pool-scoping attempts above, so the ack is not evidence of coverage.
//
// ---------------------------------------------------------------------------
// Why the subscription is per token while every other provider is per pool
// ---------------------------------------------------------------------------
//
// OKX cannot scope a subscription to a pool. Six ways of passing the pool
// address (poolAddress, poolId, pairAddress, dexContractAddress, with and
// without the token, plus a dexName filter) are all accepted and silently
// ignored, and the paid v6 channel is token-scoped too, so this is the shape of
// the product rather than a level of access.
//
// That does NOT mean OKX is measured on a different trade stream. Only
// emissions that match the reference by transaction hash are ever scored, and
// the reference is the bench pool, so the scored set is identical to the other
// four providers'. Measured over 20 minutes on the Base pool: 213 of 213 pool
// swaps appeared in OKX's stream, p50 636 ms behind our node, OKX never first.
// The off-pool trades are discarded, not scored.
//
// Their one cost is bookkeeping: an off-pool emission never matches, so it
// would expire as a miss. tokenScopedAggregators in pending_match.go exempts
// this provider from that counter, because an unmatched emission here means
// "a trade from another pool", not "a failure".
const (
	okxWSURL   = "wss://wsdexpri.okx.com:443/ws/v5/ipublic"
	okxChannel = "dex-market-trade-history"

	// The gateway closes a socket that has been idle for 30 s.
	okxPingPeriod = 20 * time.Second

	// A bench pool silent this long means the subscription is dead even
	// while pongs keep the socket alive. Same policy as the codex and
	// serialized paths. Generous because it is measured per chain and the
	// Base pool runs ~830 swaps an hour, the Solana one far more.
	okxFlowTimeout = 10 * time.Minute

	okxReadTimeout = 90 * time.Second
)

// okxChains are the chains OKX is measured on, with the token side to
// subscribe. The token is the non-stable leg of each bench pool, because
// OKX indexes trades by token and the stable leg would pull in the entire
// chain's stablecoin flow.
var okxChains = []struct {
	ChainName string // metrics label, must match headLagPools
	OKXChain  string // OKX's own chain index: 8453 Base, 501 Solana, 56 BNB
	Token     string
}{
	{ChainName: "base", OKXChain: "8453", Token: "0x4200000000000000000000000000000000000006"},
	{ChainName: "solana", OKXChain: "501", Token: "So11111111111111111111111111111111111111112"},
	{ChainName: "bnb", OKXChain: "56", Token: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"},
}

type okxTrade struct {
	ChainID string `json:"chainId"`
	TxHash  string `json:"txHash"`
	// Not a string. The WebSocket sends unix millis as a JSON NUMBER while the
	// REST endpoint of the same product sends the same field quoted. Declaring
	// it string made every WS frame fail to decode on this one field, with the
	// hash already parsed correctly just above it: 136 of 136 frames rejected.
	Timestamp okxMillis `json:"timestamp"`
	DexName   string    `json:"dexName"`
}

// okxMillis accepts the timestamp in either shape, quoted or bare.
//
// It never fails the decode: a timestamp we cannot read leaves the value zero,
// which the caller treats as "no provider timestamp", because losing the whole
// trade over a field neither measured chain actually publishes would be a far
// worse trade than losing the field.
type okxMillis int64

func (m *okxMillis) UnmarshalJSON(b []byte) error {
	*m = okxMillis(parseOKXMillis(strings.Trim(strings.TrimSpace(string(b)), `"`)))
	return nil
}

type okxFrame struct {
	Event string `json:"event"`
	Msg   string `json:"msg"`
	Code  string `json:"code"`
	Arg   struct {
		Channel     string `json:"channel"`
		ExtraParams string `json:"extraParams"`
	} `json:"arg"`
	// Raw because this channel sends `data` as a single OBJECT, not the array
	// every other OKX channel uses. Declaring []okxTrade here makes every data
	// frame fail to unmarshal, and the read loop skips what it cannot parse, so
	// the monitor acks its subscribe and then silently scores nothing. That
	// shipped once: 163 frames arrived and 0 trades came out of them.
	Data json.RawMessage `json:"data"`
}

// okxFrameTrades reads `data` whichever shape it arrives in.
//
// Observed live: this channel sends one object per frame. The array form is
// accepted too because the documented v6 `trades` channel uses it, and a
// provider that quietly switches shape should not take the monitor silent.
func okxFrameTrades(raw json.RawMessage) []okxTrade {
	if len(raw) == 0 {
		return nil
	}
	var many []okxTrade
	if err := json.Unmarshal(raw, &many); err == nil {
		return many
	}
	var one okxTrade
	if err := json.Unmarshal(raw, &one); err == nil && one.TxHash != "" {
		return []okxTrade{one}
	}
	return nil
}

// okxExtraParams is the arg shape the gateway actually honours. Flat keys are
// accepted and ignored, which is why this is a nested JSON string.
func okxExtraParams(chainID, token string) string {
	b, err := json.Marshal(map[string]string{
		"chainId":              chainID,
		"tokenContractAddress": token,
	})
	if err != nil {
		// Both inputs are constants from okxChains; a failure here is a
		// programming error, not a runtime condition.
		return ""
	}
	return string(b)
}

// okxChainName maps OKX's chain index back to our metrics label, so a frame
// that arrives on the wrong subscription is never scored on the wrong chain.
func okxChainName(okxChain string) (string, bool) {
	for _, c := range okxChains {
		if c.OKXChain == okxChain {
			return c.ChainName, true
		}
	}
	return "", false
}

// runOKXHeadLagMonitor holds one socket per chain, because the gateway keys
// subscriptions by channel name alone: it acks a second token on the same
// connection and then ignores it, so sharing a socket would silently measure
// only the first chain.
func runOKXHeadLagMonitor(config *Config, stopChan <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()
	fmt.Printf("[HEAD-LAG][OKX] Starting WebSocket monitors for %d chains...\n", len(okxChains))

	var inner sync.WaitGroup
	for _, c := range okxChains {
		inner.Add(1)
		go func(chainName, okxChain, token string) {
			defer inner.Done()
			okxRunChain(config, chainName, okxChain, token, stopChan)
		}(c.ChainName, c.OKXChain, c.Token)
	}
	inner.Wait()
	fmt.Println("[HEAD-LAG][OKX] All chain monitors stopped")
}

// okxRunChain redials with backoff forever. The connected gauge is cleared on
// every exit so the page cannot show a live reading for a dead socket.
func okxRunChain(config *Config, chainName, okxChain, token string, stopChan <-chan struct{}) {
	const baseDelay = 5 * time.Second
	const maxDelay = 60 * time.Second
	delay := baseDelay
	attempt := 0

	for {
		select {
		case <-stopChan:
			return
		default:
		}
		attempt++
		err := okxConnectAndStream(config, chainName, okxChain, token, stopChan)
		RecordWSConnected("okx", config.MonitorRegion, false)

		select {
		case <-stopChan:
			return
		default:
		}

		if err != nil {
			RecordWSReconnect("okx", config.MonitorRegion)
			RecordHeadLagError("okx", chainName, "disconnect", config.MonitorRegion)
			log.Printf("[HEAD-LAG][OKX][%s] attempt #%d ended: %v, reconnect in %v",
				chainName, attempt, err, delay)
		} else {
			log.Printf("[HEAD-LAG][OKX][%s] stream closed cleanly, reconnect in %v", chainName, delay)
		}

		select {
		case <-stopChan:
			return
		case <-time.After(delay):
		}

		// Exponential backoff, capped. A successful stream resets it below.
		delay *= 2
		if delay > maxDelay {
			delay = maxDelay
		}
	}
}

func okxConnectAndStream(config *Config, chainName, okxChain, token string, stopChan <-chan struct{}) error {
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.Dial(okxWSURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	// One writer only. Both the ping goroutine and the subscribe below go
	// through this, because gorilla panics on concurrent writes.
	var writeMu sync.Mutex
	send := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteJSON(v)
	}
	sendRaw := func(s string) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteMessage(websocket.TextMessage, []byte(s))
	}

	if err := send(map[string]any{
		"op": "subscribe",
		"args": []map[string]string{{
			"channel":     okxChannel,
			"extraParams": okxExtraParams(okxChain, token),
		}},
	}); err != nil {
		return fmt.Errorf("subscribe %s: %w", chainName, err)
	}

	done := make(chan struct{})
	defer close(done)

	// Keepalive. OKX's own client sends the bare string "ping" and the
	// gateway answers "pong"; a JSON frame is not accepted here.
	go func() {
		t := time.NewTicker(okxPingPeriod)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-stopChan:
				return
			case <-t.C:
				if err := sendRaw("ping"); err != nil {
					return
				}
			}
		}
	}()

	// Flow watchdog. An ack with no frames is the documented failure mode of
	// a wrong arg shape, and a feed that goes quiet later looks identical, so
	// both are treated the same: purge the gauge and force a redial rather
	// than let the page hold a frozen value.
	var lastMu sync.Mutex
	lastTrade := time.Now()
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-stopChan:
				return
			case <-t.C:
				lastMu.Lock()
				idle := time.Since(lastTrade)
				lastMu.Unlock()
				if idle > okxFlowTimeout {
					log.Printf("[HEAD-LAG][OKX][%s] no trade in %v, forcing redial", chainName, idle.Round(time.Second))
					RecordHeadLagError("okx", chainName, "flow_stall", config.MonitorRegion)
					DeleteHeadLagSeries("okx", chainName, config.MonitorRegion)
					_ = conn.Close()
					return
				}
			}
		}
	}()

	// Not marked connected until a frame actually arrives: the ack is not
	// evidence this subscription is alive.
	framesSeen := false

	for {
		select {
		case <-stopChan:
			return nil
		default:
		}

		_ = conn.SetReadDeadline(time.Now().Add(okxReadTimeout))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		receiveTime := time.Now()

		// "pong" is a bare string, not JSON.
		if trimmed := strings.TrimSpace(string(raw)); trimmed == "pong" || trimmed == "ping" {
			continue
		}

		var f okxFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			continue
		}
		if f.Event == "error" {
			return fmt.Errorf("gateway error %s: %s", f.Code, f.Msg)
		}
		if f.Event == "subscribe" {
			log.Printf("[HEAD-LAG][OKX][%s] subscribe acked, waiting for frames", chainName)
			continue
		}
		trades := okxFrameTrades(f.Data)
		if len(trades) == 0 {
			continue
		}

		if !framesSeen {
			framesSeen = true
			RecordWSConnected("okx", config.MonitorRegion, true)
			fmt.Printf("[HEAD-LAG][OKX][%s] pushing trades\n", chainName)
		}
		lastMu.Lock()
		lastTrade = receiveTime
		lastMu.Unlock()

		for _, t := range trades {
			okxHandleTrade(config, chainName, t, receiveTime)
		}
	}
}

// okxHandleTrade scores one pushed trade.
//
// providerLag is computed and passed for completeness, but neither chain here
// publishes it: Base reads the reference clock and Solana the race. That is
// deliberate, see the note on BNB at the top of this file. OKX's timestamps are
// whole seconds, so this figure must never become a headline.
func okxHandleTrade(config *Config, subChain string, t okxTrade, receiveTime time.Time) {
	hash := strings.TrimSpace(t.TxHash)
	if hash == "" {
		return
	}

	// A frame carrying another chain's index means the gateway misrouted it.
	// Score it on the chain it claims, never on the subscription's.
	chainName := subChain
	if t.ChainID != "" {
		mapped, ok := okxChainName(t.ChainID)
		if !ok {
			return
		}
		chainName = mapped
	}

	providerLag := 0.0
	if ms := int64(t.Timestamp); ms > 0 {
		providerLag = receiveTime.Sub(time.UnixMilli(ms)).Seconds()
	}

	emitHeadLag("okx", chainName, config.MonitorRegion, hash, receiveTime, 0, providerLag)
}

// parseOKXMillis reads the unix-millis timestamp OKX sends as a string.
// Returns 0 when it is absent or unparseable, which the caller treats as
// "no provider timestamp" rather than as epoch.
func parseOKXMillis(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	var ms int64
	if _, err := fmt.Sscanf(s, "%d", &ms); err != nil {
		return 0
	}
	// Guard against a seconds-precision value arriving where millis are
	// expected: anything below this is not a plausible millisecond epoch.
	if ms < 1_000_000_000_000 {
		return 0
	}
	return ms
}
