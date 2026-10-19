package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

var directClient = &http.Client{Timeout: 15 * time.Second}

// proxyClient routes through an HTTP proxy. Used for one provider only
// (CoinGecko's keyless API answers 429 to the VPS's shared address), and
// that provider publishes no latency here for exactly that reason.
func proxyClient(raw string) (*http.Client, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = http.ProxyURL(u)
	return &http.Client{Timeout: 15 * time.Second, Transport: tr}, nil
}

type httpStatusError struct{ code int }

func (e httpStatusError) Error() string { return fmt.Sprintf("http %d", e.code) }

// countedError wraps an error whose request was already counted in
// requests_total by a fetcher that makes several calls per round.
type countedError struct{ err error }

func (e countedError) Error() string { return e.err.Error() }
func (e countedError) Unwrap() error { return e.err }

type decodeError struct{ err error }

func (e decodeError) Error() string { return "decode: " + e.err.Error() }

// getJSON does a GET (or a JSON POST when body is non-nil) and decodes the
// answer into out. client nil means the direct client.
func getJSON(ctx context.Context, client *http.Client, u string, headers map[string]string, out any) error {
	return doJSON(ctx, client, http.MethodGet, u, headers, nil, out)
}

func postJSON(ctx context.Context, client *http.Client, u string, headers map[string]string, body any, out any) error {
	return doJSON(ctx, client, http.MethodPost, u, headers, body, out)
}

func doJSON(ctx context.Context, client *http.Client, method, u string, headers map[string]string, body any, out any) error {
	if client == nil {
		client = directClient
	}
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "openchainbench-price-api-accuracy/1.0 (+https://openchainbench.com)")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return httpStatusError{resp.StatusCode}
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out); err != nil {
		return decodeError{err}
	}
	return nil
}

func classify(err error) string {
	var hs httpStatusError
	var de decodeError
	var ne net.Error
	switch {
	case errors.As(err, &hs) && hs.code == 429:
		return "rate_limited"
	case errors.As(err, &hs) && hs.code == 402:
		return "rate_limited"
	case errors.As(err, &hs) && hs.code >= 500:
		return "http_5xx"
	case errors.As(err, &hs):
		return "http_4xx"
	case errors.As(err, &de):
		return "decode"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return "timeout"
	default:
		return "error"
	}
}
