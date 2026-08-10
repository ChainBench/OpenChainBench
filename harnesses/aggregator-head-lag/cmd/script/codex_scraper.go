package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
)

// in-process JWE refresher: scrapes defined.fi every 5 min via headless Chrome.
// Result is stored here so GetDefinedJWTToken can use it without hitting the Paris box.
var inProcessJWE struct {
	sync.RWMutex
	token     string
	mintedAt  time.Time
}

func getInProcessJWE() (string, time.Time) {
	inProcessJWE.RLock()
	defer inProcessJWE.RUnlock()
	return inProcessJWE.token, inProcessJWE.mintedAt
}

func setInProcessJWE(token string) {
	inProcessJWE.Lock()
	defer inProcessJWE.Unlock()
	inProcessJWE.token = token
	inProcessJWE.mintedAt = time.Now()
}

// scrapeCodexToken runs headless Chrome, navigates to defined.fi, and extracts the codex_token JWE.
func scrapeCodexToken() (string, error) {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.UserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
	)

	// Allow overriding Chrome binary path via env (useful for Alpine/Debian containers).
	if chromePath := os.Getenv("CHROME_PATH"); chromePath == "" {
		// Try common locations
		for _, p := range []string{"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"} {
			if _, err := os.Stat(p); err == nil {
				opts = append(opts, chromedp.ExecPath(p))
				break
			}
		}
	} else {
		opts = append(opts, chromedp.ExecPath(chromePath))
	}

	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer allocCancel()

	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	ctx, cancel = context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	var cookies []*network.Cookie
	err := chromedp.Run(ctx,
		chromedp.Navigate("https://www.defined.fi/"),
		chromedp.WaitVisible(`body`, chromedp.ByQuery),
		chromedp.Sleep(20*time.Second),
		chromedp.ActionFunc(func(ctx context.Context) error {
			var err error
			cookies, err = network.GetCookies().Do(ctx)
			return err
		}),
	)
	if err != nil {
		return "", fmt.Errorf("chromedp run failed: %w", err)
	}

	for _, c := range cookies {
		if c.Name == "codex_token" {
			decoded, err := url.QueryUnescape(c.Value)
			if err != nil {
				return "", fmt.Errorf("url unescape failed: %w", err)
			}
			var obj struct {
				Token string `json:"token"`
			}
			if err := json.Unmarshal([]byte(decoded), &obj); err == nil && obj.Token != "" {
				return obj.Token, nil
			}
			// Fallback: if the cookie value is the JWE directly
			if strings.HasPrefix(decoded, "eyJ") {
				return decoded, nil
			}
		}
	}
	return "", fmt.Errorf("codex_token cookie not found after page load")
}

// chromeAvailable returns true if a Chrome/Chromium binary is found on this host.
func chromeAvailable() bool {
	for _, p := range []string{
		os.Getenv("CHROME_PATH"),
		"/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
	} {
		if p != "" {
			if _, err := os.Stat(p); err == nil {
				return true
			}
		}
	}
	return false
}

// startInProcessScraper launches a background goroutine that refreshes the JWE every 5 min.
// Call once from main. No-ops silently if Chrome is not installed.
func startInProcessScraper(stopChan <-chan struct{}) {
	if !chromeAvailable() {
		fmt.Println("[CODEX-SCRAPER] Chrome not found — in-process scraper disabled (sidecar will be used)")
		return
	}

	go func() {
		// Initial delay: let the container fully start before launching Chrome.
		select {
		case <-stopChan:
			return
		case <-time.After(10 * time.Second):
		}

		refreshInterval := 5 * time.Minute

		for {
			fmt.Println("[CODEX-SCRAPER] Scraping defined.fi for fresh JWE...")
			tok, err := scrapeCodexToken()
			if err != nil {
				fmt.Printf("[CODEX-SCRAPER] Scrape failed: %v — retrying in 60s\n", err)
				select {
				case <-stopChan:
					return
				case <-time.After(60 * time.Second):
					continue
				}
			}
			setInProcessJWE(tok)
			fmt.Printf("[CODEX-SCRAPER] Fresh JWE stored (len=%d), next refresh in %v\n", len(tok), refreshInterval)

			select {
			case <-stopChan:
				return
			case <-time.After(refreshInterval):
			}
		}
	}()
}
