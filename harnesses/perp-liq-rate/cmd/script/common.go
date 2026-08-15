package main

// common.go — shared types and helpers used by every venue source.
//
// This file exists so the eight source_*.go files do not each re-implement
// HTTP plumbing and decimal parsing. It defines the LiqEvent normalization
// type and the Source interface that every venue implements.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// LiqEvent is a single liquidation event normalized across venues.
type LiqEvent struct {
	Key         string  // dedup key (trade hash or tx+index composite)
	NotionalUSD float64 // liquidated notional in USD
	TimestampMs int64   // event time, unix milliseconds
}

// Source is implemented by every venue in the source_*.go files.
// Each venue exports exactly these two functions as methods (free functions
// with identical names would collide inside a single package).
type Source interface {
	FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error)
	FetchOI(asset string) (float64, error)
}

// ErrVenueUnavailable marks a venue as temporarily unavailable for this tick
// (e.g. lighter returning 404/501). The runner sets health=0 but treats it
// differently from a hard fetch error.
var ErrVenueUnavailable = errors.New("venue unavailable")

// unavailableError wraps ErrVenueUnavailable with suppression state so that
// after N consecutive failures the runner stops incrementing error counters
// and logging (see source_lighter.go).
type unavailableError struct {
	status     int
	suppressed bool
}

func (e *unavailableError) Error() string {
	return fmt.Sprintf("venue unavailable (http %d)", e.status)
}

func (e *unavailableError) Unwrap() error { return ErrVenueUnavailable }

// httpClient is shared by all venues. 10s timeout per call, per spec.
var httpClient = &http.Client{Timeout: 10 * time.Second}

// maxBodyBytes caps response bodies (DefiLlama protocol payloads can be
// several MB because they embed full TVL history).
const maxBodyBytes = 64 << 20

// httpStatusError is returned for non-2xx responses.
type httpStatusError struct {
	Code int
	URL  string
	Body string // truncated snippet, for logs
}

func (e *httpStatusError) Error() string {
	if e.Body != "" {
		return fmt.Sprintf("http %d from %s: %s", e.Code, e.URL, e.Body)
	}
	return fmt.Sprintf("http %d from %s", e.Code, e.URL)
}

// httpGetRaw performs a GET and returns the raw body of a 2xx response.
func httpGetRaw(rawURL string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	return doRaw(req)
}

// httpGetJSON performs a GET and decodes the JSON body into out.
func httpGetJSON(rawURL string, out any) error {
	body, err := httpGetRaw(rawURL)
	if err != nil {
		return err
	}
	return decodeJSON(body, rawURL, out)
}

// httpPostJSON performs a POST with a JSON payload and decodes the JSON
// response into out (out may be nil to discard the body).
func httpPostJSON(rawURL string, payload any, out any) error {
	buf, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, rawURL, bytes.NewReader(buf))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	body, err := doRaw(req)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return decodeJSON(body, rawURL, out)
}

func doRaw(req *http.Request) ([]byte, error) {
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "perp-liq-rate/1.0")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet := strings.TrimSpace(string(body))
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return nil, &httpStatusError{Code: resp.StatusCode, URL: req.URL.String(), Body: snippet}
	}
	return body, nil
}

func decodeJSON(body []byte, rawURL string, out any) error {
	if err := json.Unmarshal(body, out); err != nil {
		host := rawURL
		if u, uerr := url.Parse(rawURL); uerr == nil {
			host = u.Host
		}
		return fmt.Errorf("decode response from %s: %w", host, err)
	}
	return nil
}

// decodeListFlexible decodes either a bare JSON array or an object wrapping
// the array under the given key (some venues are inconsistent about this).
func decodeListFlexible(body []byte, key string, out any) error {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		return json.Unmarshal(trimmed, out)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &m); err != nil {
		return fmt.Errorf("decode envelope: %w", err)
	}
	v, ok := m[key]
	if !ok {
		return fmt.Errorf("response missing %q array", key)
	}
	return json.Unmarshal(v, out)
}

// parseF parses a plain decimal float string.
func parseF(s string) (float64, error) {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, fmt.Errorf("parse float %q: %w", s, err)
	}
	return v, nil
}

// parseScaled parses a (possibly huge) decimal integer string and divides it
// by 10^decimals, using big.Float so 30-decimal fixed-point values (GMX) and
// i128 strings (Vertex) do not overflow along the way.
func parseScaled(s string, decimals int) (float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty numeric string")
	}
	f, ok := new(big.Float).SetPrec(256).SetString(s)
	if !ok {
		return 0, fmt.Errorf("bad numeric string %q", s)
	}
	if decimals > 0 {
		scale := new(big.Float).SetPrec(256).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
		f.Quo(f, scale)
	}
	v, _ := f.Float64()
	return v, nil
}

// flexFloat unmarshals JSON values that may arrive either as a number or as
// a numeric string ("123.4" vs 123.4). Null decodes to 0.
type flexFloat float64

func (f *flexFloat) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		*f = 0
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		s = strings.TrimSpace(s)
		if s == "" {
			*f = 0
			return nil
		}
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return err
		}
		*f = flexFloat(v)
		return nil
	}
	var v float64
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*f = flexFloat(v)
	return nil
}

// classifyError maps an error to a low-cardinality error_type label value.
func classifyError(err error) string {
	var statusErr *httpStatusError
	var jsonSyn *json.SyntaxError
	var jsonType *json.UnmarshalTypeError
	var numErr *strconv.NumError
	var netErr net.Error
	switch {
	case errors.Is(err, ErrVenueUnavailable):
		return "unavailable"
	case errors.As(err, &statusErr):
		switch {
		case statusErr.Code >= 500:
			return "http_5xx"
		case statusErr.Code >= 400:
			return "http_4xx"
		default:
			return "http_status"
		}
	case errors.As(err, &netErr) && netErr.Timeout():
		return "timeout"
	case errors.As(err, &jsonSyn), errors.As(err, &jsonType):
		return "decode"
	case errors.As(err, &numErr):
		return "parse"
	default:
		return "other"
	}
}
