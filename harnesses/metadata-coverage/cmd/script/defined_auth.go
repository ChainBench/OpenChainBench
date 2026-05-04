package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

// GetDefinedJWTToken returns a cached JWT token or generates a new one if expired
func GetDefinedJWTToken(sessionCookie string) (string, error) {
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

// generateDefinedJWTToken generates a new JWT token from Defined.fi session cookie
func generateDefinedJWTToken(sessionCookie string) (string, error) {
	fmt.Println("[DEFINED-AUTH] Generating new JWT token from Defined.fi (local)...")
	fmt.Println("[DEFINED-AUTH] Creating new HTTP client with fresh TCP connection (no keepalive)")

	// Create a new HTTP client with fresh connection for each request.
	// CRITICAL: route through HTTP_PROXY/HTTPS_PROXY (webshare rotating proxy)
	// so each JWT mint hits a fresh IP. Direct from the container IP gets us
	// stuck on Vercel's bot ban (429 loop) when the container restarts often.
	transport := &http.Transport{
		DisableKeepAlives:   true,
		MaxIdleConnsPerHost: 0,
		Proxy:               http.ProxyFromEnvironment,
	}
	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: transport,
	}

	reqBody := map[string]interface{}{
		"operationName": "CreateApiToken",
		"query":         "mutation CreateApiToken { createApiTokens(input: { count: 1 }) { token } }",
		"variables":     map[string]interface{}{},
	}

	bodyBytes, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "https://www.defined.fi/api", bytes.NewBuffer(bodyBytes))

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
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
	req.AddCookie(&http.Cookie{Name: "session", Value: sessionCookie})

	fmt.Println("[DEFINED-AUTH] Sending POST request to https://www.defined.fi/api...")
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[DEFINED-AUTH] ❌ Request failed: %v\n", err)
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	fmt.Printf("[DEFINED-AUTH] Response status: %d\n", resp.StatusCode)

	if resp.StatusCode == 429 {
		// Parse retry-after header if available
		retryAfter := resp.Header.Get("Retry-After")
		fmt.Printf("[DEFINED-AUTH] ⚠ Rate limited! Retry-After: %s\n", retryAfter)
		if retryAfter != "" {
			return "", fmt.Errorf("rate limited (429), retry after: %s", retryAfter)
		}
		return "", fmt.Errorf("rate limited (429), too many token requests - will retry later")
	}

	if resp.StatusCode != 200 {
		fmt.Printf("[DEFINED-AUTH] ❌ Unexpected status %d: %s\n", resp.StatusCode, string(respBody[:min(len(respBody), 100)]))
		return "", fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(respBody[:min(len(respBody), 100)]))
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

	fmt.Printf("[DEFINED-AUTH] ✅ JWT token generated successfully (length: %d)\n", len(tokenResp.Data.CreateApiTokens[0].Token))
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
