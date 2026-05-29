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
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chromedp/cdproto/fetch"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
	"github.com/gorilla/websocket"
	utls "github.com/refraction-networking/utls"
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
	fmt.Printf("[HEAD-LAG][GMGN] target pool: %s (%s) region=%s\n",
		solPool.Name, solPool.Address, config.MonitorRegion)

	// Initial cookie mint. Don't return on failure — the reconnect loop will
	// keep retrying and the refresher goroutine will keep trying every 25 min.
	fmt.Printf("[HEAD-LAG][GMGN] minting initial cf_clearance via chromedp (chrome at %s)…\n",
		os.Getenv("CHROME_PATH"))
	if err := gmgnRefreshSession(stopChan); err != nil {
		fmt.Printf("[HEAD-LAG][GMGN] initial cookie mint failed: %v — will retry\n", err)
	} else {
		fmt.Printf("[HEAD-LAG][GMGN] initial cookie mint OK\n")
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
			fmt.Printf("[HEAD-LAG][GMGN] connection error: %v — reconnect in %v (failures=%d)\n",
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
				fmt.Printf("[HEAD-LAG][GMGN] %d consecutive failures, force cookie refresh\n", failures)
				if refreshErr := gmgnRefreshSession(stopChan); refreshErr != nil {
					fmt.Printf("[HEAD-LAG][GMGN] force cookie refresh failed: %v\n", refreshErr)
				}
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
				fmt.Printf("[HEAD-LAG][GMGN] periodic cookie refresh failed: %v\n", err)
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
	// chromium rejects --proxy-server URLs that embed user:pass with
	// ERR_NO_SUPPORTED_PROXIES, so we strip credentials and re-inject
	// them via the CDP Fetch.authRequired handler below.
	proxyURL, proxyUser, proxyPass := gmgnProxyParts()
	if proxyURL != "" {
		opts = append(opts, chromedp.ProxyServer(proxyURL))
		fmt.Printf("[HEAD-LAG][GMGN] using proxy %s (auth=%v)\n", proxyURL, proxyUser != "")
	} else {
		// chromium silently falls back to $HTTP_PROXY when --proxy-server is
		// absent, which would re-use the rotating proxy's embedded creds and
		// fail with ERR_INVALID_AUTH_CREDENTIALS. Force a direct connection.
		opts = append(opts, chromedp.ProxyServer("direct://"))
		fmt.Println("[HEAD-LAG][GMGN] no proxy (direct connection, GMGN_PROXY=none)")
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
			return
		}
		if e, ok := ev.(*fetch.EventAuthRequired); ok && proxyUser != "" {
			go func() {
				_ = chromedp.Run(browserCtx,
					fetch.ContinueWithAuth(e.RequestID, &fetch.AuthChallengeResponse{
						Response: fetch.AuthChallengeResponseResponseProvideCredentials,
						Username: proxyUser,
						Password: proxyPass,
					}),
				)
			}()
			return
		}
		if e, ok := ev.(*fetch.EventRequestPaused); ok {
			go func() {
				_ = chromedp.Run(browserCtx, fetch.ContinueRequest(e.RequestID))
			}()
		}
	})

	var cookies []*network.Cookie
	var ua string
	runSteps := []chromedp.Action{}
	if proxyUser != "" {
		// Enable Fetch with auth handling so EventAuthRequired fires for
		// the 407 challenge our rotating residential proxy issues.
		runSteps = append(runSteps, fetch.Enable().WithHandleAuthRequests(true))
	}
	runSteps = append(runSteps,
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
	err := chromedp.Run(browserCtx, runSteps...)
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
	fmt.Printf("[HEAD-LAG][GMGN] cookie minted (%d cookies, ws=%s)\n", len(parts), wsURL)
	return nil
}

// gmgnDialer returns a websocket dialer that respects the same proxy
// choice as the chromedp mint (via GMGN_PROXY override). When the mint
// uses no proxy, the dial must also use no proxy so Cloudflare sees the
// same source IP that the cf_clearance cookie is bound to.
//
// Cloudflare on gmgn.ai 403s connections whose TLS ClientHello doesn't
// match a real browser (JA3 fingerprint), so we hand the TLS handshake
// off to utls with HelloChrome_120. EnableCompression matches Chrome's
// permessage-deflate WS extension advertisement.
func gmgnDialer() *websocket.Dialer {
	dialer := &websocket.Dialer{
		NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: -1}
			return d.DialContext(ctx, network, addr)
		},
		NetDialTLSContext: gmgnTLSDial,
		HandshakeTimeout:  30 * time.Second,
		EnableCompression: true,
	}
	cleanURL, user, pass := gmgnProxyParts()
	if cleanURL == "" {
		return dialer
	}
	u, err := url.Parse(cleanURL)
	if err != nil {
		return dialer
	}
	if user != "" {
		u.User = url.UserPassword(user, pass)
	}
	dialer.Proxy = http.ProxyURL(u)
	return dialer
}

// gmgnTLSDial dials TCP then performs the TLS handshake using utls with
// a Chrome 120 ClientHello so the JA3 fingerprint Cloudflare sees matches
// a real browser. Without this, gmgn.ai 403s the WS upgrade despite the
// chromedp-minted cf_clearance cookie being valid.
//
// The Chrome 120 preset advertises ALPN [h2, http/1.1]. WS upgrade is
// HTTP/1.1-only — if the server picks h2 we read back a SETTINGS frame
// and gorilla errors with "malformed HTTP response". Strip h2 from the
// ALPN extension while keeping every other byte of the Chrome ClientHello
// intact (JA3 ignores ALPN payload so the fingerprint stays Chrome).
func gmgnTLSDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: -1}
	rawConn, err := d.DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	uConn := utls.UClient(rawConn, &utls.Config{ServerName: host}, utls.HelloCustom)
	spec, err := utls.UTLSIdToSpec(utls.HelloChrome_120)
	if err != nil {
		_ = rawConn.Close()
		return nil, fmt.Errorf("utls spec: %w", err)
	}
	for _, ext := range spec.Extensions {
		if alpn, ok := ext.(*utls.ALPNExtension); ok {
			alpn.AlpnProtocols = []string{"http/1.1"}
		}
	}
	if err := uConn.ApplyPreset(&spec); err != nil {
		_ = rawConn.Close()
		return nil, fmt.Errorf("utls apply preset: %w", err)
	}
	if err := uConn.HandshakeContext(ctx); err != nil {
		_ = rawConn.Close()
		return nil, fmt.Errorf("utls handshake: %w", err)
	}
	return uConn, nil
}

// gmgnProxyParts returns the proxy URL stripped of any user:pass
// credentials, plus the username/password to inject later via the CDP
// Fetch.authRequired handler. chromium's --proxy-server flag rejects
// embedded credentials with ERR_NO_SUPPORTED_PROXIES.
//
// Cloudflare on gmgn.ai binds cf_clearance to the IP that minted it.
// Webshare's rotating endpoint assigns a fresh IP per TCP connection,
// so the cookie minted by chromedp is rejected on the subsequent
// gorilla WS dial (403 bad handshake). GMGN_PROXY lets us override:
//   - unset → use HTTP_PROXY / HTTPS_PROXY (existing behavior)
//   - "none" → skip proxy entirely (mint + dial from Railway IP)
//   - "<url>" → use this URL (e.g. a sticky-session Webshare endpoint)
func gmgnProxyParts() (cleanURL, user, pass string) {
	override := strings.TrimSpace(os.Getenv("GMGN_PROXY"))
	if strings.EqualFold(override, "none") {
		return "", "", ""
	}
	raw := override
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("HTTP_PROXY"))
	}
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("HTTPS_PROXY"))
	}
	if raw == "" {
		return "", "", ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw, "", ""
	}
	if u.User != nil {
		user = u.User.Username()
		pass, _ = u.User.Password()
		u.User = nil
	}
	return u.String(), user, pass
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

	dialer := gmgnDialer()
	conn, resp, err := dialer.Dial(sess.WSURL, headers)
	if err != nil {
		status := 0
		var body, cfRay, cfMitigated, server string
		if resp != nil {
			status = resp.StatusCode
			cfRay = resp.Header.Get("Cf-Ray")
			cfMitigated = resp.Header.Get("Cf-Mitigated")
			server = resp.Header.Get("Server")
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			_ = resp.Body.Close()
			body = strings.TrimSpace(strings.ReplaceAll(string(b), "\n", " "))
		}
		fmt.Printf("[HEAD-LAG][GMGN] dial 403 details: server=%q cf-ray=%q cf-mitigated=%q body=%.200q\n",
			server, cfRay, cfMitigated, body)
		return fmt.Errorf("dial failed (http=%d): %w", status, err)
	}
	defer conn.Close()
	fmt.Printf("[HEAD-LAG][GMGN] WS connected, subscribing chain_stat for chain=%s\n", gmgnChain)

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

	var msgCount int
	var lastStatLog time.Time
	channelCounts := map[string]int{}
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
		msgCount++

		if string(data) == "ping" {
			writeMu.Lock()
			_ = conn.WriteMessage(websocket.TextMessage, []byte("pong"))
			writeMu.Unlock()
			continue
		}

		// Log the first 10 frames raw so we can see what's actually coming
		// over the wire (channel, t, gk fields). Truncated to 300 chars.
		if msgCount <= 10 {
			preview := string(data)
			if len(preview) > 300 {
				preview = preview[:300] + "...(truncated)"
			}
			fmt.Printf("[HEAD-LAG][GMGN] sample msg #%d: %s\n", msgCount, preview)
		}

		// Per-channel summary every 30s so we can see the traffic mix
		// without spamming the log.
		var env gmgnFrame
		if json.Unmarshal(data, &env) == nil {
			channelCounts[env.Channel]++
		}
		if time.Since(lastStatLog) > 30*time.Second {
			fmt.Printf("[HEAD-LAG][GMGN] frames=%d channels=%v target_pool=%s\n",
				msgCount, channelCounts, pool.Address)
			lastStatLog = time.Now()
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
		// GMGN does NOT push per-pair route_info for arbitrary Solana
		// pools — verified by 90s isolated sniff: only gk="s" (slot
		// updates) and one preset pool (58oQ...) ever appear. Track
		// gk="s" so the metric reflects GMGN's view of the Solana tip
		// (head-lag at the slot level), which is the apples-to-apples
		// comparable to other aggregators' chain-tip tracking.
		if ri.T != "route_info" || ri.C != gmgnChain || ri.GK != "s" {
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
// sub-field. For gk="s" frames: `rs` = `<ms>:<slot>`, `sc` = `<ms>:<slot>:<base64>`.
// `rbh` looks like `<ms>:<blockhash>:<slot>:<ts>` so its parts[1] isn't numeric
// and falls through naturally (ParseUint fails, loop continues).
func gmgnExtractAnchor(d map[string]json.RawMessage) (int64, uint64, bool) {
	for _, k := range []string{"rs", "sc", "p", "a", "b", "rbh"} {
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

var gmgnEmitCount atomic.Int64
var gmgnLastEmitLog atomic.Int64

func gmgnEmitLag(pool HeadLagPool, obsMs int64, slot uint64, receivedAt time.Time, region string) {
	obsTime := time.UnixMilli(obsMs).UTC()
	lagSeconds := receivedAt.Sub(obsTime).Seconds()
	RecordHeadLag("gmgn", pool.ChainName, int64(slot), lagSeconds, region, "")
	n := gmgnEmitCount.Add(1)
	now := time.Now().Unix()
	if now-gmgnLastEmitLog.Load() >= 10 {
		gmgnLastEmitLog.Store(now)
		fmt.Printf("[HEAD-LAG][GMGN] emit #%d: slot=%d lag=%.3fs chain=%s region=%s\n",
			n, slot, lagSeconds, pool.ChainName, region)
	}
}

func gmgnRandHex(n int) string {
	const hex = "0123456789abcdef"
	b := make([]byte, n)
	for i := range b {
		b[i] = hex[rand.Intn(16)]
	}
	return string(b)
}
