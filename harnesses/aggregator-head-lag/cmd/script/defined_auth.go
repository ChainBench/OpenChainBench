package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type DefinedTokenResponse struct {
	Data struct {
		CreateApiTokens []struct {
			Token string `json:"token"`
		} `json:"createApiTokens"`
	} `json:"data"`
}

// JWT token cache to avoid rate limiting
type tokenCache struct {
	mu          sync.RWMutex
	token       string
	expiresAt   time.Time
	lastRefresh time.Time
}

var globalTokenCache = &tokenCache{}

// decodeJWTExpiration extracts the expiration time from a JWT token
func decodeJWTExpiration(token string) (time.Time, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, fmt.Errorf("invalid JWT format")
	}

	// Decode payload (second part)
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, fmt.Errorf("failed to decode JWT payload: %w", err)
	}

	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}, fmt.Errorf("failed to unmarshal JWT claims: %w", err)
	}

	if claims.Exp == 0 {
		return time.Time{}, fmt.Errorf("no expiration in JWT")
	}

	return time.Unix(claims.Exp, 0), nil
}

// tryDirectCodexToken calls /api/codex/token on defined.fi directly using the session cookie.
// No proxy so the JWE is minted from this container's own IP, matching the WS connection IP.
func tryDirectCodexToken(sessionCookie string) (string, error) {
	if sessionCookie == "" {
		return "", fmt.Errorf("no session cookie")
	}
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DisableKeepAlives: true,
		},
	}
	req, err := http.NewRequest("GET", "https://www.defined.fi/api/codex/token", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("Origin", "https://www.defined.fi")
	req.Header.Set("Referer", "https://www.defined.fi/")
	req.Header.Set("sec-ch-ua", `"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"`)
	req.Header.Set("sec-ch-ua-mobile", "?0")
	req.Header.Set("sec-ch-ua-platform", `"macOS"`)
	req.Header.Set("sec-fetch-dest", "empty")
	req.Header.Set("sec-fetch-mode", "cors")
	req.Header.Set("sec-fetch-site", "same-origin")
	req.AddCookie(&http.Cookie{Name: "defined-attestation-token", Value: sessionCookie})
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("status %d: %.100s", resp.StatusCode, string(body))
	}
	var parsed struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(body, &parsed); err == nil && parsed.Token != "" {
		return parsed.Token, nil
	}
	return "", fmt.Errorf("no token in response: %.100s", string(body))
}

// tryTokenService calls the Paris-box sidecar (DEFINED_TOKEN_SERVICE_URL) for a fresh JWE.
func tryTokenService(baseURL string) (string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	for _, path := range []string{"/token", "/jwt", "/"} {
		resp, err := client.Get(baseURL + path)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			continue
		}
		var parsed struct{ Token string `json:"token"` }
		if err := json.Unmarshal(body, &parsed); err == nil && parsed.Token != "" {
			return parsed.Token, nil
		}
		s := strings.TrimSpace(string(body))
		if len(s) > 50 {
			return s, nil
		}
	}
	return "", fmt.Errorf("no working path on sidecar")
}

// GetDefinedJWTToken returns a cached JWT token or generates a new one if expired.
// Priority: CODEX_JWT env var > in-process scraper (fresh, <5min) > direct /api/codex/token > sidecar > inline mint.
func GetDefinedJWTToken(sessionCookie string) (string, error) {
	if jwt := os.Getenv("CODEX_JWT"); jwt != "" {
		return jwt, nil
	}
	// In-process scraper: headless Chrome running inside this container, freshest possible.
	// JWE expires in ~10 min; scraper refreshes every 5 min so token is always <5 min old.
	if tok, mintedAt := getInProcessJWE(); tok != "" && time.Since(mintedAt) < 8*time.Minute {
		fmt.Printf("[DEFINED-AUTH] Got token from in-process scraper (age=%v, len=%d)\n", time.Since(mintedAt).Round(time.Second), len(tok))
		return tok, nil
	}
	// utls Chrome fingerprint scraper: visits defined.fi, gets CSRF, POSTs to /api/codex/token.
	// Works if this container's IP is not in Vercel's datacenter blocklist.
	if tok, err := tryUtlsCodexToken(); err == nil && tok != "" {
		fmt.Printf("[DEFINED-AUTH] Got token via utls scraper (len=%d)\n", len(tok))
		return tok, nil
	} else {
		fmt.Printf("[DEFINED-AUTH] utls scraper failed: %v\n", err)
	}
	// Direct mint (standard Go TLS, usually blocked by Vercel bot check).
	if tok, err := tryDirectCodexToken(sessionCookie); err == nil && tok != "" {
		fmt.Printf("[DEFINED-AUTH] Got token via direct /api/codex/token (len=%d)\n", len(tok))
		return tok, nil
	}
	// Sidecar fallback (Paris box, Mac-push keeps it fresh every 5 min)
	if svcURL := os.Getenv("DEFINED_TOKEN_SERVICE_URL"); svcURL != "" {
		if tok, err := tryTokenService(svcURL); err == nil && tok != "" {
			fmt.Printf("[DEFINED-AUTH] Got token from sidecar (len=%d)\n", len(tok))
			return tok, nil
		}
	}

	globalTokenCache.mu.RLock()

	// Check if we have a valid cached token
	// Renew 1 hour before expiration to be safe
	if globalTokenCache.token != "" && time.Now().Before(globalTokenCache.expiresAt.Add(-1*time.Hour)) {
		token := globalTokenCache.token
		globalTokenCache.mu.RUnlock()
		return token, nil
	}
	globalTokenCache.mu.RUnlock()

	// Need to refresh token
	globalTokenCache.mu.Lock()
	defer globalTokenCache.mu.Unlock()

	// Double-check after acquiring write lock
	if globalTokenCache.token != "" && time.Now().Before(globalTokenCache.expiresAt.Add(-1*time.Hour)) {
		return globalTokenCache.token, nil
	}

	// Generate new token
	token, err := generateDefinedJWTToken(sessionCookie)
	if err != nil {
		return "", err
	}

	// Decode expiration from token
	expiresAt, err := decodeJWTExpiration(token)
	if err != nil {
		fmt.Printf("[DEFINED-AUTH] Warning: Could not decode token expiration: %v. Will cache for 24h.\n", err)
		expiresAt = time.Now().Add(24 * time.Hour)
	}

	// Cache the token
	globalTokenCache.token = token
	globalTokenCache.expiresAt = expiresAt
	globalTokenCache.lastRefresh = time.Now()

	timeUntilExpiry := time.Until(expiresAt)
	fmt.Printf("[DEFINED-AUTH] JWT token refreshed. Expires in %.1fh (at %s)\n",
		timeUntilExpiry.Hours(), expiresAt.Format("2006-01-02 15:04:05"))

	return token, nil
}

// generateDefinedJWTToken generates a new JWT token via un.defined.fi (old UI, still alive).
// No session cookie or CSRF needed. Falls back to www.defined.fi/api proxy path.
func generateDefinedJWTToken(_ string) (string, error) {
	fmt.Println("[DEFINED-AUTH] Generating token via un.defined.fi legacy API...")

	reqBody := map[string]interface{}{
		"operationName": "CreateApiToken",
		"query":         "mutation CreateApiToken { createApiTokens(input: { count: 1 }) { token } }",
		"variables":     map[string]interface{}{},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	transport := &http.Transport{
		DisableKeepAlives: true,
		Proxy:             http.ProxyFromEnvironment,
	}
	client := &http.Client{Timeout: 10 * time.Second, Transport: transport}

	req, _ := http.NewRequest("POST", "https://un.defined.fi/api", bytes.NewBuffer(bodyBytes))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Origin", "https://un.defined.fi")
	req.Header.Set("Referer", "https://un.defined.fi/")
	req.Header.Set("sec-ch-ua", `"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"`)
	req.Header.Set("sec-ch-ua-mobile", "?0")
	req.Header.Set("sec-ch-ua-platform", `"macOS"`)
	req.Header.Set("sec-fetch-dest", "empty")
	req.Header.Set("sec-fetch-mode", "cors")
	req.Header.Set("sec-fetch-site", "same-origin")

	fmt.Println("[DEFINED-AUTH] POST https://un.defined.fi/api ...")
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[DEFINED-AUTH] ❌ Request failed: %v\n", err)
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	fmt.Printf("[DEFINED-AUTH] Response status: %d\n", resp.StatusCode)

	if resp.StatusCode == 429 {
		retryAfter := resp.Header.Get("Retry-After")
		fmt.Printf("[DEFINED-AUTH] ⚠ Rate limited! Retry-After: %s\n", retryAfter)
		return "", fmt.Errorf("rate limited (429)")
	}

	if resp.StatusCode != 200 {
		n := len(respBody)
		if n > 100 { n = 100 }
		fmt.Printf("[DEFINED-AUTH] ❌ Unexpected status %d: %s\n", resp.StatusCode, string(respBody[:n]))
		return "", fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(respBody[:n]))
	}

	var tokenResp DefinedTokenResponse
	if err := json.Unmarshal(respBody, &tokenResp); err != nil {
		fmt.Printf("[DEFINED-AUTH] ❌ Failed to decode response: %v\n", err)
		return "", fmt.Errorf("failed to decode: %w", err)
	}

	if len(tokenResp.Data.CreateApiTokens) == 0 {
		fmt.Println("[DEFINED-AUTH] ❌ No token in response")
		return "", fmt.Errorf("no token returned")
	}

	fmt.Printf("[DEFINED-AUTH] ✅ Token generated via un.defined.fi (length: %d)\n", len(tokenResp.Data.CreateApiTokens[0].Token))
	return tokenResp.Data.CreateApiTokens[0].Token, nil
}

// InvalidateTokenCache forces a token refresh on next request
func InvalidateTokenCache() {
	globalTokenCache.mu.Lock()
	defer globalTokenCache.mu.Unlock()
	globalTokenCache.token = ""
	globalTokenCache.expiresAt = time.Time{}
	fmt.Println("[DEFINED-AUTH] Token cache invalidated - will refresh on next request")
}
