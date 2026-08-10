package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	ctx, cancel = context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	cookies := map[string]string{}

	err := chromedp.Run(ctx,
		chromedp.Navigate("https://www.defined.fi/"),
		chromedp.WaitVisible(`body`, chromedp.ByQuery),
		chromedp.Sleep(8*time.Second),
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
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "chrome error: %v\n", err)
		os.Exit(1)
	}

	// Try codex_token first (it's a pre-minted token, might be usable directly)
	// It's stored as URL-encoded JSON: {"token":"<jwt>"}
	if raw, ok := cookies["codex_token"]; ok {
		decoded, err := url.QueryUnescape(raw)
		if err == nil {
			var obj struct {
				Token string `json:"token"`
			}
			if json.Unmarshal([]byte(decoded), &obj) == nil && obj.Token != "" {
				fmt.Fprintf(os.Stderr, "\ncodex_token JWT (len=%d): %s...\n", len(obj.Token), obj.Token[:min(60, len(obj.Token))])
				// Test if we can use this token directly for a Codex query
				testCodexToken(obj.Token)
			}
		}
	}

	// Also test defined-attestation-token for JWT minting
	if attToken, ok := cookies["defined-attestation-token"]; ok {
		fmt.Fprintf(os.Stderr, "\nTesting defined-attestation-token for JWT mint...\n")
		testJWTMint(attToken, "defined-attestation-token")
	}

	// Output fresh defined-attestation-token
	if attToken, ok := cookies["defined-attestation-token"]; ok {
		fmt.Printf("DEFINED_SESSION_COOKIE=%s\n", attToken)
		fmt.Printf("COOKIE_NAME=defined-attestation-token\n")
	}

	// Also output full codex_token JSON decoded token
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

func testJWTMint(cookieValue, cookieName string) {
	reqBody := map[string]interface{}{
		"operationName": "CreateApiToken",
		"query":         "mutation CreateApiToken { createApiTokens(input: { count: 1 }) { token } }",
		"variables":     map[string]interface{}{},
	}
	bodyBytes, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "https://www.defined.fi/api", bytes.NewBuffer(bodyBytes))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://www.defined.fi")
	req.Header.Set("Referer", "https://www.defined.fi/")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.AddCookie(&http.Cookie{Name: cookieName, Value: cookieValue})

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mint request failed: %v\n", err)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	fmt.Fprintf(os.Stderr, "mint status: %d, body: %s\n", resp.StatusCode, string(body[:min(200, len(body))]))
}

func testCodexToken(token string) {
	// Try using the token directly as a Bearer for Codex GraphQL
	reqBody := map[string]interface{}{
		"query": "{ getNetworkStats(networkId: 1) { addressCount } }",
	}
	bodyBytes, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "https://graph.codex.io/graphql", bytes.NewBuffer(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "codex token test failed: %v\n", err)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	fmt.Fprintf(os.Stderr, "codex test status: %d, body: %s\n", resp.StatusCode, string(body[:min(200, len(body))]))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
