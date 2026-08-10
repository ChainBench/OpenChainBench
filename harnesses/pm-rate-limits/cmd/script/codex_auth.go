package main

// JWT mint logic vendored from
//   miniapps/aggregator-latency-benchmark/cmd/script/defined_auth.go
// keeping the same Webshare-proxy + 7-day-cookie flow. Reusing the working
// production pattern instead of re-inventing — the head-lag bench has been
// minting JWTs against defined.fi this way for months.

import (
	"bytes"
	"encoding/base64"
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

type definedTokenResponse struct {
	Data struct {
		CreateApiTokens []struct {
			Token string `json:"token"`
		} `json:"createApiTokens"`
	} `json:"data"`
}

type definedTokenCache struct {
	mu          sync.RWMutex
	token       string
	expiresAt   time.Time
	lastRefresh time.Time
}

var codexTokenCache = &definedTokenCache{}

func decodeJWTExpiration(token string) (time.Time, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, fmt.Errorf("invalid JWT format")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, err
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}, err
	}
	if claims.Exp == 0 {
		return time.Time{}, fmt.Errorf("no exp")
	}
	return time.Unix(claims.Exp, 0), nil
}

// GetCodexJWT returns a cached short-lived JWT, minting a new one when the
// cached one is within 1h of expiry.
// If CODEX_JWT env var is set, it is returned directly (bypasses session-cookie flow).
func GetCodexJWT(sessionCookie string) (string, error) {
	if jwt := os.Getenv("CODEX_JWT"); jwt != "" {
		return jwt, nil
	}
	codexTokenCache.mu.RLock()
	if codexTokenCache.token != "" && time.Now().Before(codexTokenCache.expiresAt.Add(-1*time.Hour)) {
		t := codexTokenCache.token
		codexTokenCache.mu.RUnlock()
		return t, nil
	}
	codexTokenCache.mu.RUnlock()

	codexTokenCache.mu.Lock()
	defer codexTokenCache.mu.Unlock()
	if codexTokenCache.token != "" && time.Now().Before(codexTokenCache.expiresAt.Add(-1*time.Hour)) {
		return codexTokenCache.token, nil
	}
	tok, err := mintCodexJWT(sessionCookie)
	if err != nil {
		return "", err
	}
	exp, err := decodeJWTExpiration(tok)
	if err != nil {
		exp = time.Now().Add(24 * time.Hour)
	}
	codexTokenCache.token = tok
	codexTokenCache.expiresAt = exp
	codexTokenCache.lastRefresh = time.Now()
	log.Printf("[codex-auth] JWT refreshed, expires in %.1fh", time.Until(exp).Hours())
	return tok, nil
}

func InvalidateCodexJWT() {
	codexTokenCache.mu.Lock()
	defer codexTokenCache.mu.Unlock()
	codexTokenCache.token = ""
	codexTokenCache.expiresAt = time.Time{}
	log.Printf("[codex-auth] JWT cache invalidated")
}

func mintCodexJWT(sessionCookie string) (string, error) {
	// CRITICAL: route through HTTP_PROXY / HTTPS_PROXY (Webshare). Direct
	// Railway IPs get stuck in Vercel's bot-ban loop after a few mints.
	tr := &http.Transport{DisableKeepAlives: true, Proxy: http.ProxyFromEnvironment}
	client := &http.Client{Timeout: 15 * time.Second, Transport: tr}

	body := map[string]interface{}{
		"operationName": "CreateApiToken",
		"query":         "mutation CreateApiToken { createApiTokens(input: { count: 1 }) { token } }",
		"variables":     map[string]interface{}{},
	}
	bb, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "https://www.defined.fi/api", bytes.NewBuffer(bb))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://www.defined.fi")
	req.Header.Set("Referer", "https://www.defined.fi/")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("sec-ch-ua", `"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"`)
	req.Header.Set("sec-ch-ua-mobile", "?0")
	req.Header.Set("sec-ch-ua-platform", `"macOS"`)
	req.Header.Set("sec-fetch-dest", "empty")
	req.Header.Set("sec-fetch-mode", "cors")
	req.Header.Set("sec-fetch-site", "same-origin")
	req.AddCookie(&http.Cookie{Name: "defined-attestation-token", Value: sessionCookie})

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 429 {
		return "", fmt.Errorf("rate limited (429)")
	}
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(rb))
	}
	var tr2 definedTokenResponse
	if err := json.Unmarshal(rb, &tr2); err != nil {
		return "", err
	}
	if len(tr2.Data.CreateApiTokens) == 0 {
		return "", fmt.Errorf("no token in response")
	}
	return tr2.Data.CreateApiTokens[0].Token, nil
}

func snippet(b []byte) string {
	if len(b) > 200 {
		return string(b[:200])
	}
	return string(b)
}
