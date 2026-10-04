package main

import (
	"bytes"
	"errors"
	"compress/zlib"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

)

// ============================================================================
// Birdeye head lag monitor
// ============================================================================
//
// Birdeye's documented WebSocket needs a Premium plan ($199/month). The socket
// their own token pages hold needs no credential at all, and it is a different
// host from the documented one: multichain-socket.birdeye.so rather than
// public-api.birdeye.so. Looking for an open channel on the documented host is
// what made this look impossible for two days.
//
// Three things to know, each of which produced a wrong conclusion first:
//
//  1. The dial FAILS without a User-Agent. Cloudflare's default rule answers
//     403 "Just a moment..." to a client that declares none. Tested one factor
//     at a time: no headers 403, Origin alone 403, Origin + User-Agent 101.
//     That is the whole gate; no TLS fingerprinting is involved and the uTLS
//     machinery in utls_codex.go is not needed here.
//
//  2. Frames are zlib-compressed JSON, not text and not a bespoke binary
//     format. DevTools shows them as "Binary message", which reads like
//     protobuf until you notice the 78 9c magic.
//
//  3. An ack proves nothing, as on the OKX path. Only decoded trades do, so
//     the connected gauge is not set until a TXS_DATA frame arrives.
//
// Base and Solana only, for the same two reasons OKX is limited to them:
// `blockUnixTime` is in whole SECONDS, so a chain whose headline reads the
// provider's own timestamp (anything outside referenceChains and raceChains)
// would publish that quantisation as Birdeye's latency; and Robinhood Chain is
// not covered upstream.
//
// Like OKX, the subscription is per token rather than per pool, so most of
// what arrives is off-bench and is discarded: only emissions matched to the
// reference by transaction hash are scored. See tokenScopedAggregators in
// pending_match.go for why those unmatched emissions are not counted as misses.
const (
	birdeyeWSHost = "wss://multichain-socket.birdeye.so"
	birdeyeOrigin = "https://birdeye.so"
	birdeyeUA     = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
		"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

	// Solana pushed 152 trade frames in 40 s on the bench token, Base 27. A
	// gap this long is a dead subscription, not a quiet market.
	birdeyeFlowTimeout = 10 * time.Minute
	birdeyeReadTimeout = 90 * time.Second

	// Consecutive 403s after which this chain gives up for good. The edge
	// scores the egress IP, so an environment that is refused once will be
	// refused every time; retrying past this only hammers a third party.
	birdeyeForbiddenGiveUp = 3
)

// errBirdeyeForbidden marks the one failure that retrying cannot fix.
var errBirdeyeForbidden = errors.New(
	"403 from the edge: this egress IP is refused. The same dial succeeds from " +
		"a residential connection and from the OVH VPS, so this is not a header " +
		"problem and not transient")

// birdeyeChains mirrors okxChains: the non-stable leg of each bench pool,
// because the feed is indexed by token and the stable leg would pull in the
// whole chain's stablecoin flow.
var birdeyeChains = []struct {
	ChainName string // metrics label, must match headLagPools
	Path      string // per-chain socket path
	Token     string
}{
	{ChainName: "solana", Path: "/solana/socket-optimize", Token: "So11111111111111111111111111111111111111112"},
	{ChainName: "base", Path: "/base/socket-optimize", Token: "0x4200000000000000000000000000000000000006"},
}

type birdeyeTrade struct {
	TxHash        string  `json:"txHash"`
	BlockUnixTime float64 `json:"blockUnixTime"`
	Source        string  `json:"source"`
	Side          string  `json:"side"`
}

type birdeyeFrame struct {
	Type string         `json:"type"`
	Data []birdeyeTrade `json:"data"`
}

// birdeyeHeaders is not optional. Without the User-Agent the dial is answered
// 403 by Cloudflare before the upgrade, which reads as "the socket is closed"
// rather than "you forgot a header".
func birdeyeHeaders() http.Header {
	h := http.Header{}
	h.Set("Origin", birdeyeOrigin)
	h.Set("User-Agent", birdeyeUA)
	return h
}

// birdeyeInflate returns the JSON carried by a frame. Trade frames are zlib
// (magic 78 9c); control frames such as WELLCOME and ACK arrive as plain text.
func birdeyeInflate(raw []byte) string {
	if len(raw) > 1 && raw[0] == 0x78 {
		if r, err := zlib.NewReader(bytes.NewReader(raw)); err == nil {
			defer r.Close()
			if out, err := io.ReadAll(io.LimitReader(r, 4<<20)); err == nil {
				return string(out)
			}
		}
	}
	return string(raw)
}

func runBirdeyeHeadLagMonitor(config *Config, stopChan <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()
	// Birdeye's edge refuses this project's Railway egress, so the dial only
	// works through the proxy. getProxyDialer falls back to a direct dial when
	// the variable is missing, silently, which is indistinguishable from the
	// proxy itself being refused. Say which it is.
	proxy := os.Getenv("HTTP_PROXY")
	if proxy == "" {
		proxy = os.Getenv("HTTPS_PROXY")
	}
	if proxy == "" {
		fmt.Println("[HEAD-LAG][BIRDEYE] no HTTP_PROXY in the environment: dialing direct, " +
			"which Birdeye's edge refuses from this host")
	} else {
		fmt.Printf("[HEAD-LAG][BIRDEYE] proxy configured (%d chars)\n", len(proxy))
	}
	fmt.Printf("[HEAD-LAG][BIRDEYE] Starting WebSocket monitors for %d chains...\n", len(birdeyeChains))

	var inner sync.WaitGroup
	for _, c := range birdeyeChains {
		inner.Add(1)
		go func(chain, path, token string) {
			defer inner.Done()
			birdeyeRunChain(config, chain, path, token, stopChan)
		}(c.ChainName, c.Path, c.Token)
	}
	inner.Wait()
	fmt.Println("[HEAD-LAG][BIRDEYE] All chain monitors stopped")
}

func birdeyeRunChain(config *Config, chainName, path, token string, stopChan <-chan struct{}) {
	const baseDelay = 5 * time.Second
	const maxDelay = 60 * time.Second
	delay := baseDelay
	attempt := 0
	forbidden := 0

	for {
		select {
		case <-stopChan:
			return
		default:
		}
		attempt++
		err := birdeyeConnectAndStream(config, chainName, path, token, stopChan)
		RecordWSConnected("birdeye", config.MonitorRegion, false)

		select {
		case <-stopChan:
			return
		default:
		}

		if errors.Is(err, errBirdeyeForbidden) {
			forbidden++
			RecordHeadLagError("birdeye", chainName, "forbidden", config.MonitorRegion)
			if forbidden >= birdeyeForbiddenGiveUp {
				log.Printf("[HEAD-LAG][BIRDEYE][%s] %d consecutive 403s, disabling this chain. %v",
					chainName, forbidden, err)
				return
			}
		} else if err != nil {
			forbidden = 0
			RecordWSReconnect("birdeye", config.MonitorRegion)
			RecordHeadLagError("birdeye", chainName, "disconnect", config.MonitorRegion)
			log.Printf("[HEAD-LAG][BIRDEYE][%s] attempt #%d ended: %v, reconnect in %v",
				chainName, attempt, err, delay)
		} else {
			forbidden = 0
		}

		select {
		case <-stopChan:
			return
		case <-time.After(delay):
		}
		delay *= 2
		if delay > maxDelay {
			delay = maxDelay
		}
	}
}

func birdeyeConnectAndStream(config *Config, chainName, path, token string, stopChan <-chan struct{}) error {
	// Through the proxy, like geckoterminal and both mobula paths. Dialing
	// direct is what made this 403 from Railway while the same binary got 101
	// from a laptop and from the OVH VPS: the edge scores the egress IP, and
	// HTTP_PROXY is already set on these services for exactly this reason.
	dialer := getProxyDialer()
	dialer.HandshakeTimeout = 20 * time.Second
	conn, resp, err := dialer.Dial(birdeyeWSHost+path, birdeyeHeaders())
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusForbidden {
			// Not a header problem: the same dial, same headers, succeeds from
			// a laptop and from the OVH VPS and is refused from Railway. The
			// edge is scoring the egress IP, so retrying cannot help.
			return errBirdeyeForbidden
		}
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	var writeMu sync.Mutex
	if err := func() error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteJSON(map[string]any{
			"type": "SUBSCRIBE_TXS",
			"data": map[string]any{"address": token, "filter": map[string]any{}},
		})
	}(); err != nil {
		return fmt.Errorf("subscribe %s: %w", chainName, err)
	}

	done := make(chan struct{})
	defer close(done)

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
				if idle > birdeyeFlowTimeout {
					log.Printf("[HEAD-LAG][BIRDEYE][%s] no trade in %v, forcing redial",
						chainName, idle.Round(time.Second))
					RecordHeadLagError("birdeye", chainName, "flow_stall", config.MonitorRegion)
					DeleteHeadLagSeries("birdeye", chainName, config.MonitorRegion)
					_ = conn.Close()
					return
				}
			}
		}
	}()

	framesSeen := false
	for {
		select {
		case <-stopChan:
			return nil
		default:
		}

		_ = conn.SetReadDeadline(time.Now().Add(birdeyeReadTimeout))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		receiveTime := time.Now()

		var f birdeyeFrame
		if err := json.Unmarshal([]byte(birdeyeInflate(raw)), &f); err != nil {
			continue
		}
		// WELLCOME (their spelling) and ACK arrive before any trade. Neither is
		// evidence the subscription is live.
		if f.Type != "TXS_DATA" || len(f.Data) == 0 {
			continue
		}

		if !framesSeen {
			framesSeen = true
			RecordWSConnected("birdeye", config.MonitorRegion, true)
			fmt.Printf("[HEAD-LAG][BIRDEYE][%s] pushing trades\n", chainName)
		}
		lastMu.Lock()
		lastTrade = receiveTime
		lastMu.Unlock()

		for _, t := range f.Data {
			birdeyeHandleTrade(config, chainName, t, receiveTime)
		}
	}
}

// birdeyeHandleTrade scores one pushed trade.
//
// providerLag is computed for completeness and published on neither measured
// chain: Base reads the reference clock, Solana the race. blockUnixTime is in
// whole seconds, so this figure must never become a headline.
func birdeyeHandleTrade(config *Config, chainName string, t birdeyeTrade, receiveTime time.Time) {
	hash := strings.TrimSpace(t.TxHash)
	if hash == "" {
		return
	}
	providerLag := 0.0
	if t.BlockUnixTime > 1e9 {
		providerLag = receiveTime.Sub(time.Unix(int64(t.BlockUnixTime), 0)).Seconds()
	}
	emitHeadLag("birdeye", chainName, config.MonitorRegion, hash, receiveTime, 0, providerLag)
}
