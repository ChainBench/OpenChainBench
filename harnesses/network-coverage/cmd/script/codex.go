package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

const codexGraphQLURL = "https://graph.codex.io/graphql"

type codexNetwork struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type codexResponse struct {
	Data   struct{ GetNetworks []codexNetwork `json:"getNetworks"` } `json:"data"`
	Errors []struct{ Message string `json:"message"` } `json:"errors"`
}

// fetchCodex queries the Codex GraphQL `getNetworks` endpoint.
// Auth: same path as the metadata-coverage harness — mint a JWT from the
// Defined.fi session cookie. Falls back to skipping if no cookie is set.
func fetchCodex(cfg *Config) ProviderResult {
	res := ProviderResult{Provider: "codex"}

	// Prefer official Codex API key when set — no mint, no proxy, no cookie.
	bearer := cfg.CodexAPIKey
	if bearer == "" {
		if cfg.CodexSessionCookie == "" && cfg.DefinedTokenURL == "" {
			res.Err = "missing_codex_auth"
			return res
		}
		jwt, err := getCodexJWT(cfg)
		if err != nil {
			res.Err = fmt.Sprintf("jwt_error: %v", err)
			return res
		}
		bearer = jwt
	}

	body := map[string]any{
		"query": "query GetNetworks { getNetworks { id name } }",
	}
	bodyBytes, _ := json.Marshal(body)

	// Explicit transport via env proxy — when fallback path is used (cookie/JWT),
	// graph.codex.io must be reached through the same rotating IPs as the mint
	// to keep auth state consistent.
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment}
	client := &http.Client{Timeout: 15 * time.Second, Transport: transport}
	req, _ := http.NewRequest("POST", codexGraphQLURL, bytes.NewBuffer(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	// Official Codex API keys are sent as raw value; minted JWTs use "Bearer ".
	if cfg.CodexAPIKey != "" {
		req.Header.Set("Authorization", bearer)
	} else {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	resp, err := client.Do(req)
	if err != nil {
		res.Err = fmt.Sprintf("request_error: %v", err)
		return res
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		res.Err = fmt.Sprintf("status_%d", resp.StatusCode)
		return res
	}

	var parsed codexResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		res.Err = fmt.Sprintf("parse_error: %v", err)
		return res
	}
	if len(parsed.Errors) > 0 {
		res.Err = "graphql_error: " + parsed.Errors[0].Message
		return res
	}

	for _, n := range parsed.Data.GetNetworks {
		res.Networks = append(res.Networks, Network{
			ChainID: strconv.Itoa(n.ID),
			Slug:    "",
			Name:    n.Name,
		})
	}

	return res
}

// getCodexJWT mints a Defined.fi JWT from the session cookie, or pulls a
// pre-minted one from a sidecar URL if DEFINED_TOKEN_SERVICE_URL is set.
// If CODEX_JWT env var is set, it is returned directly (bypasses all other flows).
func getCodexJWT(cfg *Config) (string, error) {
	if jwt := os.Getenv("CODEX_JWT"); jwt != "" {
		return jwt, nil
	}
	// If a sidecar token service is configured, try it first. On any error,
	// silently fall back to inline mint — the sidecar isn't authoritative.
	if cfg.DefinedTokenURL != "" {
		if tok, err := tryTokenService(cfg.DefinedTokenURL); err == nil && tok != "" {
			return tok, nil
		} else if err != nil {
			fmt.Printf("[CODEX-JWT] sidecar fallback (sidecar err: %v)\n", err)
		}
	}

	// Inline mint via defined.fi/api (mirrors metadata-coverage's defined_auth.go,
	// trimmed since this harness only mints once every 6h).
	reqBody := map[string]any{
		"operationName": "CreateApiToken",
		"query":         "mutation CreateApiToken { createApiTokens(input: { count: 1 }) { token } }",
		"variables":     map[string]any{},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	transport := &http.Transport{Proxy: http.ProxyFromEnvironment}
	client := &http.Client{Timeout: 15 * time.Second, Transport: transport}

	req, _ := http.NewRequest("POST", "https://www.defined.fi/api", bytes.NewBuffer(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Origin", "https://www.defined.fi")
	req.Header.Set("Referer", "https://www.defined.fi/")
	req.AddCookie(&http.Cookie{Name: "defined-attestation-token", Value: cfg.CodexSessionCookie})

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("mint status %d: %s", resp.StatusCode, string(body[:min(200, len(body))]))
	}

	var parsed struct {
		Data struct {
			CreateApiTokens []struct{ Token string `json:"token"` } `json:"createApiTokens"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", err
	}
	if len(parsed.Data.CreateApiTokens) == 0 {
		return "", fmt.Errorf("no token in response")
	}
	return parsed.Data.CreateApiTokens[0].Token, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// tryTokenService attempts a few common path variants on the sidecar token
// service. Returns the first non-empty token, or an aggregated error.
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
		// Try JSON {"token": "..."} first, fall back to plain text body.
		var parsed struct{ Token string `json:"token"` }
		if err := json.Unmarshal(body, &parsed); err == nil && parsed.Token != "" {
			return parsed.Token, nil
		}
		s := string(bytes.TrimSpace(body))
		if s != "" && len(s) > 50 { // crude sanity — JWTs are long
			return s, nil
		}
	}
	return "", fmt.Errorf("no working path on sidecar")
}
