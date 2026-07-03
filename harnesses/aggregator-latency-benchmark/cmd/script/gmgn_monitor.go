package main

// GMGN.ai head-lag monitor — Solana only.
//
// Why Solana only: GMGN's WebSocket pushes per-pair (gk-tagged) `route_info`
// events ONLY for Solana. On Base/BSC/ETH the same `chain_stat` channel
// returns chain-level gas + coin_price but no per-pool real-time stream.
// Confirmed via devtools sniffing of gmgn.ai's own UI: their EVM chain
// pages use REST polling, not WebSocket per-pair pushes.
//
// Pipeline:
//   1. chromedp opens Chrome, navigates to https://gmgn.ai/?chain=sol,
//      lets Cloudflare clear, harvests cookies (cf_clearance + __cf_bm)
//      AND the live wss://gmgn.ai/ws?... URL the page would open.
//   2. A background goroutine refreshes the session every 25 min
//      (cf_clearance TTL is 30-45 min).
//   3. gorilla/websocket dials the captured WS URL via getProxyDialer()
//      so HTTP_PROXY/HTTPS_PROXY routes the WS through the same
//      residential proxy as Codex / GeckoTerminal.
//   4. We subscribe `chain_stat` on chain="sol" and filter incoming
//      `route_info` events where gk == bench Solana pool address.
//   5. Each event embeds `<unix_ms>:<slot>:<base64>` in d.p / d.a / d.b.
//      We use unix_ms (GMGN's pipeline observation timestamp, ms-precision)
//      as the anchor and compute head_lag = receivedAt - unix_ms. This is
//      what the bench measures for the other providers too — wall-clock
//      gap between the canonical observation moment and WebSocket receipt.
//
// Heartbeat: GMGN expects `{"action":"heartbeat","client_ts":<unix_ms>}`
// ~every 30s; we send every 25s.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
	"github.com/gorilla/websocket"
)

// GMGN monitors the same Solana pool as the rest of the head-lag bench so
// the leaderboard stays apples-to-apples. Address picked from headLagPools
// (head_lag_monitor.go) at runtime.
const gmgnChain = "sol"

// gmgnSession is the live cookie + WS URL bundle. Refreshed every 25 min;
// readers see a coherent snapshot via the atomic pointer.
type gmgnSession struct {
	WSURL        string
	CookieHeader string
	UserAgent    string
	MintedAt     time.Time
}

var gmgnSessionPtr atomic.Pointer[gmgnSession]

func runGMGNHeadLagMonitor(config *Config, stopChan <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()

	// Print unconditionally so /logs proves the goroutine actually fired.
	fmt.Println("[HEAD-LAG][GMGN] goroutine entered")

	if !config.GMGNEnabled {
		fmt.Println("[HEAD-LAG][GMGN] disabled (GMGN_ENABLED != true) — set GMGN_ENABLED=true to enable")
		return
	}
	fmt.Println("[HEAD-LAG][GMGN] starting Solana per-pair monitor…")

	var solPool HeadLagPool
	for _, p := range headLagPools {
		if p.ChainName == "solana" {
			solPool = p
			break
		}
	}
	if solPool.Address == "" {
		log.Println("[HEAD-LAG][GMGN] no Solana pool in headLagPools, aborting")
		return
	}
	log.Printf("[HEAD-LAG][GMGN] target pool: %s (%s) region=%s",
		solPool.Name, solPool.Address, config.MonitorRegion)

	// Initial cookie mint. Don't return on failure — the reconnect loop will
	// keep retrying and the refresher goroutine will keep trying every 25 min.
	log.Printf("[HEAD-LAG][GMGN] minting initial cf_clearance via chromedp (chrome at %s)…",
		os.Getenv("CHROME_PATH"))
	if err := gmgnRefreshSession(stopChan); err != nil {
		log.Printf("[HEAD-LAG][GMGN] initial cookie mint failed: %v — will retry", err)
	} else {
		log.Printf("[HEAD-LAG][GMGN] initial cookie mint OK")
	}

	// Periodic cookie refresh.
	refreshWG := &sync.WaitGroup{}
	refreshWG.Add(1)
	go func() {
		defer refreshWG.Done()
		gmgnSessionRefresher(stopChan)
	}()

	// Reconnect loop.
	reconnect := 5 * time.Second
	const reconnectMax = 60 * time.Second
	failures := 0
	for {
		select {
		case <-stopChan:
			refreshWG.Wait()
			return
		default:
		}

		err := gmgnConnectAndConsume(config, solPool, stopChan)
		if err != nil {
			failures++
			log.Printf("[HEAD-LAG][GMGN] connection error: %v — reconnect in %v (failures=%d)",
				err, reconnect, failures)
			select {
			case <-stopChan:
				refreshWG.Wait()
				return
			case <-time.After(reconnect):
				if reconnect < reconnectMax {
					reconnect *= 2
					if reconnect > reconnectMax {
						reconnect = reconnectMax
					}
				}
			}
			// After 5 consecutive failures, force a fresh cookie mint —
			// the WS may be rejecting our stale cf_clearance / IP combo.
			if failures%5 == 0 {
				log.Printf("[HEAD-LAG][GMGN] %d consecutive failures, force cookie refresh", failures)
				_ = gmgnRefreshSession(stopChan)
			}
			continue
		}
		reconnect = 5 * time.Second
		failures = 0
	}
}

func gmgnSessionRefresher(stopChan <-chan struct{}) {
	ticker := time.NewTicker(25 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-stopChan:
			return
		case <-ticker.C:
			if err := gmgnRefreshSession(stopChan); err != nil {
				log.Printf("[HEAD-LAG][GMGN] periodic cookie refresh failed: %v", err)
			}
		}
	}
}

// gmgnRefreshSession runs chromedp once, harvests cookies + WS URL, and
// atomically swaps the global session pointer.
func gmgnRefreshSession(stopChan <-chan struct{}) error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	go func() {
		select {
		case <-stopChan:
			cancel()
		case <-ctx.Done():
		}
	}()

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		chromedp.WindowSize(1280, 800),
		chromedp.UserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
	)
	if px := gmgnProxyURL(); px != "" {
		opts = append(opts, chromedp.ProxyServer(px))
	}
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(ctx, opts...)
	defer cancelAlloc()

	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()

	var (
		wsMu   sync.Mutex
		wsURLs []string
	)
	chromedp.ListenTarget(browserCtx, func(ev interface{}) {
		if e, ok := ev.(*network.EventWebSocketCreated); ok {
			wsMu.Lock()
			wsURLs = append(wsURLs, e.URL)
			wsMu.Unlock()
		}
	})

	var cookies []*network.Cookie
	var ua string
	err := chromedp.Run(browserCtx,
		network.Enable(),
		chromedp.Navigate("https://gmgn.ai/?chain=sol"),
		chromedp.WaitVisible("body", chromedp.ByQuery),
		chromedp.Sleep(6*time.Second),
		chromedp.Evaluate(`navigator.userAgent`, &ua),
		chromedp.ActionFunc(func(ctx context.Context) error {
			cs, err := network.GetCookies().Do(ctx)
			if err != nil {
				return err
			}
			cookies = cs
			return nil
		}),
	)
	if err != nil {
		return fmt.Errorf("chromedp: %w", err)
	}

	var parts []string
	for _, c := range cookies {
		if !strings.HasSuffix(c.Domain, "gmgn.ai") {
			continue
		}
		parts = append(parts, c.Name+"="+c.Value)
	}
	if len(parts) == 0 {
		return fmt.Errorf("no gmgn.ai cookies harvested")
	}

	wsMu.Lock()
	var wsURL string
	for _, u := range wsURLs {
		if strings.HasPrefix(u, "wss://gmgn.ai/ws") {
			wsURL = u
			break
		}
	}
	wsMu.Unlock()
	if wsURL == "" {
		return fmt.Errorf("page did not open the expected wss://gmgn.ai/ws URL")
	}

	gmgnSessionPtr.Store(&gmgnSession{
		WSURL:        wsURL,
		CookieHeader: strings.Join(parts, "; "),
		UserAgent:    ua,
		MintedAt:     time.Now().UTC(),
	})
	log.Printf("[HEAD-LAG][GMGN] cookie minted (%d cookies, ws=%s)", len(parts), wsURL)
	return nil
}

func gmgnProxyURL() string {
	if p := strings.TrimSpace(os.Getenv("HTTP_PROXY")); p != "" {
		return p
	}
	return strings.TrimSpace(os.Getenv("HTTPS_PROXY"))
}

func gmgnConnectAndConsume(config *Config, pool HeadLagPool, stopChan <-chan struct{}) error {
	sess := gmgnSessionPtr.Load()
	if sess == nil {
		return fmt.Errorf("no session yet (initial mint pending)")
	}

	headers := http.Header{}
	headers.Set("Origin", "https://gmgn.ai")
	headers.Set("User-Agent", sess.UserAgent)
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Pragma", "no-cache")
	headers.Set("Accept-Language", "en-US,en;q=0.9")
	headers.Set("Accept", "*/*")
	headers.Set("Sec-Fetch-Dest", "websocket")
	headers.Set("Sec-Fetch-Mode", "websocket")
	headers.Set("Sec-Fetch-Site", "same-origin")
	headers.Set("Cookie", sess.CookieHeader)

	dialer := getProxyDialer()
	conn, resp, err := dialer.Dial(sess.WSURL, headers)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		return fmt.Errorf("dial failed (http=%d): %w", status, err)
	}
	defer conn.Close()
	log.Printf("[HEAD-LAG][GMGN] WS connected, subscribing chain_stat for chain=%s", gmgnChain)

	subBody, _ := json.Marshal(map[string]any{
		"action":  "subscribe",
		"channel": "chain_stat",
		"f":       "w",
		"id":      gmgnRandHex(16),
		"data":    []map[string]string{{"chain": gmgnChain}},
	})
	if err := conn.WriteMessage(websocket.TextMessage, subBody); err != nil {
		return fmt.Errorf("subscribe write: %w", err)
	}

	hbDone := make(chan struct{})
	defer close(hbDone)
	var writeMu sync.Mutex
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-hbDone:
				return
			case <-t.C:
				hb, _ := json.Marshal(map[string]any{
					"action":    "heartbeat",
					"client_ts": time.Now().UnixMilli(),
				})
				writeMu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				_ = conn.WriteMessage(websocket.TextMessage, hb)
				writeMu.Unlock()
			}
		}
	}()

	conn.SetPingHandler(func(appData string) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteControl(websocket.PongMessage, []byte(appData),
			time.Now().Add(time.Second))
	})

	for {
		select {
		case <-stopChan:
			return nil
		default:
		}
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		if mt != websocket.TextMessage {
			continue
		}
		receivedAt := time.Now().UTC()

		if string(data) == "ping" {
			writeMu.Lock()
			_ = conn.WriteMessage(websocket.TextMessage, []byte("pong"))
			writeMu.Unlock()
			continue
		}

		gmgnHandleFrame(data, receivedAt, pool, config.MonitorRegion)
	}
}

type gmgnFrame struct {
	Channel string            `json:"channel"`
	Data    []json.RawMessage `json:"data"`
}

type gmgnRouteInfo struct {
	T  string                     `json:"t"`
	TS int64                      `json:"ts"`
	C  string                     `json:"c"`
	GK string                     `json:"gk"`
	D  map[string]json.RawMessage `json:"d"`
}

func gmgnHandleFrame(data []byte, receivedAt time.Time, pool HeadLagPool, region string) {
	var env gmgnFrame
	if err := json.Unmarshal(data, &env); err != nil {
		return
	}
	if env.Channel != "chain_stat" {
		return
	}
	for _, raw := range env.Data {
		var ri gmgnRouteInfo
		if err := json.Unmarshal(raw, &ri); err != nil {
			continue
		}
		if ri.T != "route_info" || ri.C != gmgnChain || ri.GK != pool.Address {
			continue
		}
		obsMs, slot, ok := gmgnExtractAnchor(ri.D)
		if !ok {
			continue
		}
		gmgnEmitLag(pool, obsMs, slot, receivedAt, region)
	}
}

// gmgnExtractAnchor returns (unix_ms, slot) from the first parseable
// sub-field. Each sub-field is `<unix_ms>:<slot>:<base64>`.
func gmgnExtractAnchor(d map[string]json.RawMessage) (int64, uint64, bool) {
	for _, k := range []string{"p", "a", "b", "rbh", "rs", "sc"} {
		raw, ok := d[k]
		if !ok {
			continue
		}
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			continue
		}
		parts := strings.SplitN(s, ":", 3)
		if len(parts) < 2 {
			continue
		}
		obs, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			continue
		}
		slot, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			continue
		}
		return obs, slot, true
	}
	return 0, 0, false
}

func gmgnEmitLag(pool HeadLagPool, obsMs int64, slot uint64, receivedAt time.Time, region string) {
	obsTime := time.UnixMilli(obsMs).UTC()
	lagSeconds := receivedAt.Sub(obsTime).Seconds()
	// RecordHeadLag drops anything outside [0, 30) so the sanity filter is
	// shared across providers — no special-case here.
	RecordHeadLag("gmgn", pool.ChainName, int64(slot), lagSeconds, region, "")
}

func gmgnRandHex(n int) string {
	const hex = "0123456789abcdef"
	b := make([]byte, n)
	for i := range b {
		b[i] = hex[rand.Intn(16)]
	}
	return string(b)
}
