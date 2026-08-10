package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
)

func main() {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.UserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
	)

	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()
	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()
	ctx, cancel = context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	cookies := map[string]string{}

	// Monkey-patch WebSocket to capture connection_init sent to graph.codex.io
	// and the server's first response (ack or error/close).
	captureScript := `
window.__wsCaptures = [];
window.__wsResponses = [];
const _WS = window.WebSocket;
window.WebSocket = function(url, protocols) {
	const ws = new _WS(url, protocols);
	if (url && url.includes('graph.codex.io')) {
		const _send = ws.send.bind(ws);
		ws.send = function(data) {
			try {
				const parsed = JSON.parse(data);
				if (parsed.type === 'connection_init') {
					window.__wsCaptures.push({url: url, payload: parsed.payload, raw: data});
					console.log('WS_CAPTURE:' + JSON.stringify({url, payload: parsed.payload}));
				}
			} catch(e) {}
			return _send(data);
		};
		ws.addEventListener('message', function(evt) {
			try {
				const parsed = JSON.parse(evt.data);
				window.__wsResponses.push({url: url, type: parsed.type, raw: evt.data.slice(0, 200)});
				console.log('WS_RESPONSE:' + JSON.stringify({url, type: parsed.type}));
			} catch(e) {}
		});
		ws.addEventListener('close', function(evt) {
			window.__wsResponses.push({url: url, closeCode: evt.code, reason: evt.reason});
			console.log('WS_CLOSE:' + JSON.stringify({url, code: evt.code, reason: evt.reason}));
		});
	}
	return ws;
};
window.WebSocket.prototype = _WS.prototype;
window.WebSocket.CONNECTING = _WS.CONNECTING;
window.WebSocket.OPEN = _WS.OPEN;
window.WebSocket.CLOSING = _WS.CLOSING;
window.WebSocket.CLOSED = _WS.CLOSED;
`

	err := chromedp.Run(ctx,
		// Inject monkey-patch before page loads
		chromedp.ActionFunc(func(ctx context.Context) error {
			return chromedp.Evaluate(`void 0`, nil).Do(ctx) // warm up
		}),
		chromedp.Navigate("about:blank"),
		chromedp.Evaluate(captureScript, nil),
		chromedp.Navigate("https://www.defined.fi/"),
		chromedp.WaitVisible(`body`, chromedp.ByQuery),
		// Re-inject on the loaded page (navigate clears scripts)
		chromedp.Evaluate(captureScript, nil),
		chromedp.Sleep(20*time.Second),
		chromedp.ActionFunc(func(ctx context.Context) error {
			// Get cookies
			cookieParams, err := network.GetCookies().Do(ctx)
			if err != nil {
				return fmt.Errorf("failed to get cookies: %w", err)
			}
			for _, cookie := range cookieParams {
				cookies[cookie.Name] = cookie.Value
				fmt.Fprintf(os.Stderr, "cookie: %s (len=%d)\n", cookie.Name, len(cookie.Value))
			}
			return nil
		}),
		// Capture what the browser sent in connection_init
		chromedp.ActionFunc(func(ctx context.Context) error {
			var captures []map[string]interface{}
			err := chromedp.Evaluate(`window.__wsCaptures || []`, &captures).Do(ctx)
			if err != nil {
				fmt.Fprintf(os.Stderr, "capture eval error: %v\n", err)
				return nil
			}
			if len(captures) == 0 {
				fmt.Fprintf(os.Stderr, "\n[WS CAPTURE] No connection_init captured for graph.codex.io\n")
				// Try to get captures via console approach
				var raw string
				chromedp.Evaluate(`JSON.stringify(window.__wsCaptures || [])`, &raw).Do(ctx)
				fmt.Fprintf(os.Stderr, "[WS CAPTURE] raw: %s\n", raw)
			}
			for i, c := range captures {
				fmt.Fprintf(os.Stderr, "\n[WS CAPTURE #%d] url=%v\n", i, c["url"])
				payloadBytes, _ := json.MarshalIndent(c["payload"], "", "  ")
				fmt.Fprintf(os.Stderr, "[WS CAPTURE #%d] connection_init payload:\n%s\n", i, string(payloadBytes))
				fmt.Printf("WS_INIT_PAYLOAD=%s\n", string(payloadBytes))
			}
			// Capture server responses (ack / close)
			var responses []map[string]interface{}
			chromedp.Evaluate(`window.__wsResponses || []`, &responses).Do(ctx)
			if len(responses) == 0 {
				fmt.Fprintf(os.Stderr, "\n[WS RESPONSE] No server responses captured yet\n")
			}
			for i, r := range responses {
				respBytes, _ := json.MarshalIndent(r, "", "  ")
				fmt.Fprintf(os.Stderr, "\n[WS RESPONSE #%d]:\n%s\n", i, string(respBytes))
			}
			return nil
		}),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "chrome error: %v\n", err)
		os.Exit(1)
	}

	// Output cookies
	if attToken, ok := cookies["defined-attestation-token"]; ok {
		fmt.Printf("DEFINED_SESSION_COOKIE=%s\n", attToken)
	}
	if raw, ok := cookies["codex_token"]; ok {
		decoded, _ := url.QueryUnescape(raw)
		var obj struct {
			Token string `json:"token"`
		}
		if json.Unmarshal([]byte(decoded), &obj) == nil {
			fmt.Printf("CODEX_TOKEN=%s\n", obj.Token)
		}
	}
}
