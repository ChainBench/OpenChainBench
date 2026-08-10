package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

func main() {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.UserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
	)

	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancel()
	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()
	ctx, cancel = context.WithTimeout(ctx, 120*time.Second)
	defer cancel()

	cookies := map[string]string{}
	capturedCodexAuth := ""
	apiCodexTokenResponse := ""

	// Intercept requests to api.defined.fi to capture Authorization header
	chromedp.ListenTarget(ctx, func(ev interface{}) {
		switch e := ev.(type) {
		case *network.EventRequestWillBeSent:
			if e.Request == nil {
				return
			}
			// Capture auth from api.defined.fi requests
			if len(e.Request.URL) > 20 && capturedCodexAuth == "" {
				for k, v := range e.Request.Headers {
					if k == "authorization" || k == "Authorization" {
						fmt.Fprintf(os.Stderr, "[auth intercept] %s -> %s\n",
							truncate(e.Request.URL, 60), truncate(fmt.Sprint(v), 100))
						capturedCodexAuth = fmt.Sprint(v)
					}
				}
			}
		}
	})

	err := chromedp.Run(ctx,
		chromedp.Navigate("https://www.defined.fi/"),
		chromedp.WaitVisible(`body`, chromedp.ByQuery),
		chromedp.Sleep(8*time.Second),

		// Collect cookies
		chromedp.ActionFunc(func(ctx context.Context) error {
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

		// Call /api/codex/token from the browser (bypasses Vercel challenge)
		chromedp.ActionFunc(func(ctx context.Context) error {
			script := `
new Promise((resolve, reject) => {
  fetch('https://www.defined.fi/api/codex/token', {
    method: 'POST',
    credentials: 'include',
    headers: {'Content-Type': 'application/json', 'Accept': 'application/json'}
  })
  .then(r => {
    const status = r.status;
    const hdrs = {};
    r.headers.forEach((v, k) => { hdrs[k] = v; });
    return r.text().then(body => resolve(JSON.stringify({status, headers: hdrs, body: body.substring(0, 500)})));
  })
  .catch(e => reject(e.toString()))
})
`
			var result string
			err := chromedp.Evaluate(script, &result, func(p *runtime.EvaluateParams) *runtime.EvaluateParams {
				return p.WithAwaitPromise(true)
			}).Do(ctx)
			if err != nil {
				fmt.Fprintf(os.Stderr, "/api/codex/token fetch error: %v\n", err)
				return nil
			}
			apiCodexTokenResponse = result
			fmt.Fprintf(os.Stderr, "/api/codex/token response: %s\n", result)
			return nil
		}),

		// Navigate to a token page to trigger API calls with auth headers
		chromedp.Navigate("https://www.defined.fi/eth/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"),
		chromedp.WaitVisible(`body`, chromedp.ByQuery),
		chromedp.Sleep(8*time.Second),

		// Collect updated cookies after navigation
		chromedp.ActionFunc(func(ctx context.Context) error {
			cookieParams, err := network.GetCookies().Do(ctx)
			if err != nil {
				return nil
			}
			for _, cookie := range cookieParams {
				cookies[cookie.Name] = cookie.Value
			}
			fmt.Fprintf(os.Stderr, "auth intercepted: %s\n", truncate(capturedCodexAuth, 100))
			return nil
		}),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "chrome error: %v\n", err)
		os.Exit(1)
	}

	_ = apiCodexTokenResponse

	if attToken, ok := cookies["defined-attestation-token"]; ok {
		fmt.Printf("DEFINED_SESSION_COOKIE=%s\n", attToken)
	}

	if raw, ok := cookies["codex_token"]; ok {
		decoded, _ := url.QueryUnescape(raw)
		var obj struct {
			Token string `json:"token"`
		}
		if json.Unmarshal([]byte(decoded), &obj) == nil && obj.Token != "" {
			fmt.Printf("CODEX_TOKEN=%s\n", obj.Token)
		}
	}

	if capturedCodexAuth != "" {
		fmt.Printf("CAPTURED_CODEX_AUTH=%s\n", capturedCodexAuth)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
