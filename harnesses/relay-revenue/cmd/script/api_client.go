package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// api_client.go — thin wrapper over GET https://api.relay.link/requests.
//
// Methodology notes (from audit):
//   * `limit` is server-capped at 50 (HTTP 500 above).
//   * `status=success` query param is BROKEN — must filter client side.
//   * `startTimestamp` / `endTimestamp` (unix sec) DO work server-side
//     and are the only reliable way to bound the iteration.
//   * Continuation pagination is opaque; an empty string means "no
//     more pages".
//   * No auth; rate limits are very generous (30+ concurrent ok) but
//     we keep it sequential to avoid hammering during backfill.

const (
	relayBaseURL   = "https://api.relay.link"
	relayPageLimit = 50
	relayPageMax   = 200 // hard cap per polling cycle — prevents runaway
)

// RelayClient is a tiny stateful client over the Relay HTTP API.
type RelayClient struct {
	baseURL string
	http    *http.Client
}

func NewRelayClient() *RelayClient {
	return &RelayClient{
		baseURL: relayBaseURL,
		http:    &http.Client{Timeout: 20 * time.Second},
	}
}

// FetchPageOptions controls a single /requests call.
type FetchPageOptions struct {
	Continuation   string
	StartTimestamp int64 // unix sec, 0 = unset
	EndTimestamp   int64 // unix sec, 0 = unset
}

// FetchPage performs one GET /requests call. Increments Prom counters
// for both the request and (on non-2xx) the error path.
func (c *RelayClient) FetchPage(ctx context.Context, opts FetchPageOptions) (*RelayPage, error) {
	q := url.Values{}
	q.Set("limit", strconv.Itoa(relayPageLimit))
	if opts.Continuation != "" {
		q.Set("continuation", opts.Continuation)
	}
	if opts.StartTimestamp > 0 {
		q.Set("startTimestamp", strconv.FormatInt(opts.StartTimestamp, 10))
	}
	if opts.EndTimestamp > 0 {
		q.Set("endTimestamp", strconv.FormatInt(opts.EndTimestamp, 10))
	}
	u := c.baseURL + "/requests?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("build req: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "mobula-openchainbench/relay-revenue (contact@mobula.io)")

	relayAPIRequestTotal.Inc()
	resp, err := c.http.Do(req)
	if err != nil {
		relayAPIErrorsTotal.WithLabelValues("network").Inc()
		return nil, fmt.Errorf("http get: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
	if err != nil {
		relayAPIErrorsTotal.WithLabelValues("read").Inc()
		return nil, fmt.Errorf("read body: %w", err)
	}

	if resp.StatusCode >= 400 {
		relayAPIErrorsTotal.WithLabelValues(httpErrLabel(resp.StatusCode)).Inc()
		preview := string(body)
		if len(preview) > 200 {
			preview = preview[:200]
		}
		return nil, fmt.Errorf("relay http %d: %s", resp.StatusCode, preview)
	}

	var page RelayPage
	if err := json.Unmarshal(body, &page); err != nil {
		relayAPIErrorsTotal.WithLabelValues("decode").Inc()
		return nil, fmt.Errorf("decode page: %w", err)
	}
	return &page, nil
}

func httpErrLabel(code int) string {
	switch {
	case code == 429:
		return "rate_limited"
	case code >= 500:
		return "server"
	case code >= 400:
		return "client"
	default:
		return "other"
	}
}
