package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Per-call HTTP timeout. 20s is generous for portfolio APIs that fan
// out to dozens of chain indexers server-side; anything slower is a
// vendor problem worth surfacing as a timeout error.
const httpTimeout = 20 * time.Second

// retryDelay is the wait before the single allowed retry. 30s gives a
// transient 5xx / edge timeout time to clear without burning credits
// on a hot loop.
const retryDelay = 30 * time.Second

var httpClient = &http.Client{Timeout: httpTimeout}

// httpError carries the status code so callers can branch on 4xx
// (e.g. Mobula's optional SOL/BTC probes tolerate a 400).
type httpError struct {
	status int
	body   string
}

func (e *httpError) Error() string {
	return fmt.Sprintf("http %d: %s", e.status, e.body)
}

// httpStatus returns the HTTP status behind err, or 0 for transport
// level failures (DNS, TLS, timeout).
func httpStatus(err error) int {
	if he, ok := err.(*httpError); ok {
		return he.status
	}
	return 0
}

// doCall executes one HTTP request with the standard probe semantics:
// per-call 20s timeout, single retry after 30s ONLY on 5xx or
// timeout/transport failure — never on 4xx (a 4xx is deterministic:
// retrying burns credits without changing the answer). Returns the
// response body, the total elapsed wall time across attempts, and an
// error for any non-2xx outcome.
func doCall(method, url string, headers map[string]string, body []byte) ([]byte, time.Duration, error) {
	b, elapsed, err := doOnce(method, url, headers, body)
	if err != nil && retryable(err) {
		fmt.Printf("  [retry] %s %s failed (%v), retrying in %v\n", method, url, err, retryDelay)
		time.Sleep(retryDelay)
		b2, elapsed2, err2 := doOnce(method, url, headers, body)
		return b2, elapsed + elapsed2, err2
	}
	return b, elapsed, err
}

func doOnce(method, url string, headers map[string]string, body []byte) ([]byte, time.Duration, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		return nil, 0, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	start := time.Now()
	resp, err := httpClient.Do(req)
	elapsed := time.Since(start)
	if err != nil {
		return nil, elapsed, err
	}
	defer resp.Body.Close()

	// 20MB cap: portfolio responses for a whale wallet can be large,
	// but anything bigger than this is a runaway payload.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if err != nil {
		return nil, elapsed, fmt.Errorf("read body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return raw, elapsed, &httpError{status: resp.StatusCode, body: truncate(string(raw), 200)}
	}
	return raw, elapsed, nil
}

// retryable: only transport/timeout failures and 5xx. 4xx never.
func retryable(err error) bool {
	if status := httpStatus(err); status != 0 {
		return status >= 500
	}
	// Transport-level: DNS, TLS, connection refused, context deadline.
	msg := err.Error()
	return strings.Contains(msg, "timeout") ||
		strings.Contains(msg, "deadline") ||
		strings.Contains(msg, "connection") ||
		strings.Contains(msg, "EOF") ||
		strings.Contains(msg, "no such host")
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
