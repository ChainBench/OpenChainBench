package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// One shared client with keep-alive. A client constructed per request pays
// a TCP+TLS handshake on every quote and that cost lands in the latency
// histogram, which is exactly the trap bench 069 hit.
var httpClient = &http.Client{
	Timeout:   8 * time.Second,
	Transport: &http.Transport{MaxIdleConnsPerHost: 8, IdleConnTimeout: 90 * time.Second},
}

// ErrRetryable marks 5xx and timeouts. Adapters retry these once; a 4xx is
// the provider's final answer and is never retried.
var ErrRetryable = errors.New("retryable")

type httpResult struct {
	Status  int
	Body    []byte
	Latency time.Duration
}

// doJSON performs a request with one retry on 5xx/timeout. The caller
// decides what a non-2xx body means; this only classifies retryability.
func doJSON(ctx context.Context, method, url string, headers map[string]string, body []byte) (httpResult, error) {
	var last httpResult
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		var rdr io.Reader
		if body != nil {
			rdr = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, url, rdr)
		if err != nil {
			return httpResult{}, err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com/benchmarks/fiat-onramp-cost)")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		start := time.Now()
		resp, err := httpClient.Do(req)
		lat := time.Since(start)
		if err != nil {
			lastErr = fmt.Errorf("%w: %v", ErrRetryable, err)
			last = httpResult{Latency: lat}
			continue
		}
		b, rerr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		last = httpResult{Status: resp.StatusCode, Body: b, Latency: lat}
		if rerr != nil {
			lastErr = fmt.Errorf("%w: read: %v", ErrRetryable, rerr)
			continue
		}
		if resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("%w: status %d", ErrRetryable, resp.StatusCode)
			continue
		}
		return last, nil
	}
	// A 5xx that survived the retry is the provider's answer: hand it back
	// with a nil error so the adapter labels it http_5xx, not timeout.
	if last.Status >= 500 {
		return last, nil
	}
	return last, lastErr
}

func isTimeout(err error) bool {
	if err == nil {
		return false
	}
	type timeout interface{ Timeout() bool }
	if t, ok := err.(timeout); ok && t.Timeout() {
		return true
	}
	return errors.Is(err, context.DeadlineExceeded)
}

// httpStatusError carries the provider's non-2xx answer so the cycle loop
// can label errors_total with http_4xx / http_5xx without re-parsing.
type httpStatusError struct {
	Provider string
	Status   int
	Body     string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("%s status %d: %s", e.Provider, e.Status, e.Body)
}

func statusErr(provider string, res httpResult) error {
	return &httpStatusError{Provider: provider, Status: res.Status, Body: truncate(res.Body)}
}

// endpointOverride lets tests point an adapter at an httptest server. It
// is never set from the environment: production always talks to the
// documented hosts.
var endpointOverride = map[string]string{}

func baseFor(slug, def string) string {
	if v := endpointOverride[slug]; v != "" {
		return v
	}
	return def
}
