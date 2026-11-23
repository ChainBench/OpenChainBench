package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ============================================================================
// Metastreams head lag monitor
// ============================================================================
//
// Metastreams' spot.trades channel takes a `pools` filter, so unlike OKX and
// Birdeye the subscription is scoped to the bench pool itself and everything
// that arrives should be a bench trade. It is not in tokenScopedAggregators.
//
// One socket, one subscription per chain: the documented stream limits are
// per key (20 subscriptions), and one connection carrying three is how their
// own quickstart is written. Auth is a Bearer key on the upgrade request.
//
// Three of the four bench chains. Metastreams does not index Base (its chains
// are solana, bsc, robinhood and elysium), and all three it does are
// raceChains, so the headline is our own receive time against the first
// feed. Its `timestamp` is the block time in whole SECONDS (every frame
// measured on 2026-11-17 ends in 000), so providerLag is computed for
// completeness and must never become a headline.
//
// Dialled direct, like every other WebSocket in this bench: the proxy is for
// the scraping paths, and a proxy hop on one feed only would be a handicap no
// other feed carries.
const (
	metastreamsWSURL       = "wss://api.metastreams.io/v1/stream"
	metastreamsReadTimeout = 90 * time.Second
	// The quietest bench pool (Solana SOL/USDC Raydium) runs at about 12
	// transactions a minute. A gap this long is a dead subscription.
	metastreamsFlowTimeout  = 10 * time.Minute
	metastreamsUnauthGiveUp = 3
)

var errMetastreamsUnauthorized = errors.New("401 from api.metastreams.io: key missing, wrong or revoked; retrying cannot fix it")

// metastreamsChains maps our chain label to their chain slug and the bench
// pool. Pool addresses are the headLagPools ones; the test pins that.
var metastreamsChains = []struct {
	ChainName string // metrics label, must match headLagPools
	Slug      string // Metastreams chain slug
	Pool      string
}{
	{ChainName: "solana", Slug: "solana", Pool: "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm"},
	// "bsc", not "bnb", on their side.
	{ChainName: "bnb", Slug: "bsc", Pool: "0x172fcd41e0913e95784454622d1c3724f546f849"},
	{ChainName: "robinhood", Slug: "robinhood", Pool: "0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a"},
}

type metastreamsTrade struct {
	Chain           string `json:"chain"`
	TransactionHash string `json:"transactionHash"`
	Timestamp       int64  `json:"timestamp"` // ms, block time rounded to the second
}

type metastreamsFrame struct {
	Type    string           `json:"type"`
	Channel string           `json:"channel"`
	ID      string           `json:"id"`
	Status  string           `json:"status"`
	Message string           `json:"message"`
	Data    metastreamsTrade `json:"data"`
}

func runMetastreamsHeadLagMonitor(config *Config, stopChan <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()
	if config.MetastreamsAPIKey == "" {
		fmt.Println("[HEAD-LAG][METASTREAMS] METASTREAMS_API_KEY not set, monitor disabled")
		return
	}
	fmt.Printf("[HEAD-LAG][METASTREAMS] Starting WebSocket monitor for %d chains...\n", len(metastreamsChains))

	const baseDelay = 5 * time.Second
	const maxDelay = 60 * time.Second
	delay := baseDelay
	unauth := 0
	for {
		select {
		case <-stopChan:
			return
		default:
		}
		err := metastreamsConnectAndStream(config, stopChan)
		RecordWSConnected("metastreams", config.MonitorRegion, false)
		select {
		case <-stopChan:
			return
		default:
		}
		if errors.Is(err, errMetastreamsUnauthorized) {
			unauth++
			for _, c := range metastreamsChains {
				RecordHeadLagError("metastreams", c.ChainName, "unauthorized", config.MonitorRegion)
			}
			if unauth >= metastreamsUnauthGiveUp {
				log.Printf("[HEAD-LAG][METASTREAMS] %d consecutive 401s, disabling. %v", unauth, err)
				return
			}
		} else if err != nil {
			unauth = 0
			RecordWSReconnect("metastreams", config.MonitorRegion)
			for _, c := range metastreamsChains {
				RecordHeadLagError("metastreams", c.ChainName, "disconnect", config.MonitorRegion)
			}
			log.Printf("[HEAD-LAG][METASTREAMS] stream ended: %v, reconnect in %v", err, delay)
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

func metastreamsConnectAndStream(config *Config, stopChan <-chan struct{}) error {
	dialer := websocket.Dialer{HandshakeTimeout: 20 * time.Second}
	h := http.Header{}
	h.Set("Authorization", "Bearer "+config.MetastreamsAPIKey)
	conn, resp, err := dialer.Dial(metastreamsWSURL, h)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return errMetastreamsUnauthorized
		}
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	for _, c := range metastreamsChains {
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := conn.WriteJSON(map[string]any{
			"action":  "subscribe",
			"channel": "spot.trades",
			"filters": map[string]any{"chains": []string{c.Slug}, "pools": []string{c.Pool}},
			"id":      c.ChainName,
		}); err != nil {
			return fmt.Errorf("subscribe %s: %w", c.ChainName, err)
		}
	}

	slugToChain := map[string]string{}
	for _, c := range metastreamsChains {
		slugToChain[c.Slug] = c.ChainName
	}

	done := make(chan struct{})
	defer close(done)
	var lastMu sync.Mutex
	lastTrade := map[string]time.Time{}
	start := time.Now()
	for _, c := range metastreamsChains {
		lastTrade[c.ChainName] = start
	}
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
				var stalled []string
				for chain, at := range lastTrade {
					if time.Since(at) > metastreamsFlowTimeout {
						stalled = append(stalled, chain)
					}
				}
				lastMu.Unlock()
				if len(stalled) > 0 {
					log.Printf("[HEAD-LAG][METASTREAMS] no trade in %v on %v, forcing redial",
						metastreamsFlowTimeout, stalled)
					for _, chain := range stalled {
						RecordHeadLagError("metastreams", chain, "flow_stall", config.MonitorRegion)
						DeleteHeadLagSeries("metastreams", chain, config.MonitorRegion)
					}
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
		_ = conn.SetReadDeadline(time.Now().Add(metastreamsReadTimeout))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		receiveTime := time.Now()

		var f metastreamsFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			continue
		}
		switch f.Type {
		case "update":
		case "error":
			log.Printf("[HEAD-LAG][METASTREAMS] error frame: %s", strings.TrimSpace(string(raw)))
			continue
		default:
			// An ack proves nothing; only decoded trades do.
			continue
		}
		chain, ok := slugToChain[f.Data.Chain]
		if !ok {
			continue
		}
		if !framesSeen {
			framesSeen = true
			RecordWSConnected("metastreams", config.MonitorRegion, true)
			fmt.Println("[HEAD-LAG][METASTREAMS] pushing trades")
		}
		lastMu.Lock()
		lastTrade[chain] = receiveTime
		lastMu.Unlock()
		metastreamsHandleTrade(config, chain, f.Data, receiveTime)
	}
}

func metastreamsHandleTrade(config *Config, chain string, t metastreamsTrade, receiveTime time.Time) {
	hash := strings.TrimSpace(t.TransactionHash)
	if hash == "" {
		return
	}
	// EVM hashes are compared lowercase across feeds; Solana signatures are
	// base58 and case-sensitive.
	if chain != "solana" {
		hash = strings.ToLower(hash)
	}
	providerLag := 0.0
	if t.Timestamp > 1e12 {
		providerLag = receiveTime.Sub(time.UnixMilli(t.Timestamp)).Seconds()
	}
	emitHeadLag("metastreams", chain, config.MonitorRegion, hash, receiveTime, 0, providerLag)
}
