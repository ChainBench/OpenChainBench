package main

import (
	"encoding/json"
	"errors"
	"math"
	"net"
	"strconv"
	"strings"
)

// classifyNetErr buckets transport errors into a small fixed set for the
// `error_type` label on the other-errors counter.
func classifyNetErr(err error) string {
	if err == nil {
		return "none"
	}
	s := strings.ToLower(err.Error())
	switch {
	case strings.Contains(s, "context deadline exceeded") || strings.Contains(s, "timeout"):
		return "timeout"
	case strings.Contains(s, "eof") || strings.Contains(s, "reset"):
		return "conn_drop"
	case strings.Contains(s, "no such host") || strings.Contains(s, "lookup"):
		return "dns"
	}
	var ne net.Error
	if errors.As(err, &ne) {
		if ne.Timeout() {
			return "timeout"
		}
	}
	return "network"
}

// snippet returns at most n bytes of a response body for logging without
// leaking long error pages into the ring buffer.
func snippet(b []byte) string {
	if len(b) > 200 {
		return string(b[:200])
	}
	return string(b)
}

// numAny reads a JSON value that providers spell inconsistently: KyberSwap
// returns its gas as a string, 0x as a number, and either is free to change
// without telling us. Decoding these fields as `any` and converting here keeps
// a type flip from failing the whole unmarshal and taking the provider's quote
// down with it, which would turn a cosmetic upstream change into a dark row.
//
// Returns 0 for anything it cannot read, which is the same signal the Quote
// struct uses for "the provider did not say".
func numAny(v any) float64 {
	switch x := v.(type) {
	case float64:
		if x < 0 || math.IsNaN(x) || math.IsInf(x, 0) {
			return 0
		}
		return x
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil || f < 0 || math.IsNaN(f) || math.IsInf(f, 0) {
			// Hex is how a raw transaction field arrives (LI.FI's
			// transactionRequest.gasPrice is "0x5b8d80").
			t := strings.TrimPrefix(strings.TrimSpace(x), "0x")
			if n, err2 := strconv.ParseUint(t, 16, 64); err2 == nil {
				return float64(n)
			}
			return 0
		}
		return f
	case json.Number:
		f, err := x.Float64()
		if err != nil || f < 0 {
			return 0
		}
		return f
	}
	return 0
}

// uintAny is numAny for a gas-units field.
func uintAny(v any) uint64 {
	f := numAny(v)
	if f <= 0 || f > 1e18 {
		return 0
	}
	return uint64(f)
}
