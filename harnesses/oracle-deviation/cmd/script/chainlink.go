package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// Chainlink AggregatorV3 reader. We talk JSON-RPC directly to a
// public Ethereum mainnet node instead of pulling in go-ethereum.
// Two reasons:
//
//   1. go-ethereum drags ~70 transitive dependencies for what is
//      ultimately one `eth_call` to a fixed selector. The standalone
//      JSON-RPC path keeps the harness image under 25 MB and the
//      build cache happy.
//   2. The decoded shape of latestRoundData() is fixed and tiny
//      (5 ABI-packed words). Hand-rolling the decoder is ~30 lines.
//
// Every AggregatorV3Interface implementation exposes:
//
//   function latestRoundData() external view returns (
//     uint80 roundId,
//     int256 answer,
//     uint256 startedAt,
//     uint256 updatedAt,
//     uint80 answeredInRound
//   );
//   function decimals() external view returns (uint8);
//
// We cache `decimals` per feed forever (Chainlink contracts are
// non-upgradable for this field) so the steady-state load is one
// `eth_call` per pair per poll.

// 4-byte selectors. Computed once with `cast sig 'latestRoundData()'`
// and `cast sig 'decimals()'`, hardcoded to avoid an ABI library.
const (
	selLatestRoundData = "0xfeaf968c"
	selDecimals        = "0x313ce567"
)

type rpcReq struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      int           `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
}

type rpcResp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  string          `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type chainlinkPoller struct {
	httpClient *http.Client
	// rotated[i] is the index of the next RPC to try; on consecutive
	// errors the poller flips to the fallback. Cheap atomic instead
	// of a mutex since the field is only read/written by this poller.
	rpcIdx atomic.Int32
	// decimals cache (feed → decimals). Populated lazily on first
	// successful read.
	decimalsCache map[string]int
	// unsupported feeds (addresses that don't implement AggregatorV3
	// — e.g. revert on every call). Skipped on subsequent ticks so we
	// don't burn RPC budget on dead feeds. Populated after 3 retries.
	unsupported  map[string]bool
	failureCount map[string]int
}

func newChainlinkPoller() *chainlinkPoller {
	return &chainlinkPoller{
		httpClient:    &http.Client{Timeout: httpTimeout},
		decimalsCache: make(map[string]int),
		unsupported:   make(map[string]bool),
		failureCount:  make(map[string]int),
	}
}

func (c *chainlinkPoller) rpcURL() string {
	if c.rpcIdx.Load()%2 == 0 {
		return rpcEndpoint()
	}
	return rpcEndpointFallback()
}

// runChainlink loops every pair every pollInterval. The 10 pairs are
// polled sequentially within a tick to keep the RPC budget steady
// (one batched request would be ideal — public RPCs often refuse
// JSON-RPC batches, so we stick to one call per pair).
func runChainlink(ctx context.Context, specs []PairSpec) {
	c := newChainlinkPoller()
	t := time.NewTicker(pollInterval)
	defer t.Stop()

	tick := func() {
		for _, s := range specs {
			if c.unsupported[s.ChainlinkFeed] {
				// Mark error every cycle so the deviation calc skips
				// stale values, but skip the network round-trip.
				oracleScrapeErrors.WithLabelValues(string(SourceChainlink), string(s.Pair)).Inc()
				continue
			}
			pollCtx, cancel := context.WithTimeout(ctx, httpTimeout*2)
			price, updatedAt, err := c.read(pollCtx, s.ChainlinkFeed)
			cancel()
			if err != nil {
				oracleScrapeErrors.WithLabelValues(string(SourceChainlink), string(s.Pair)).Inc()
				c.failureCount[s.ChainlinkFeed]++
				// Distinguish reverts (permanent — bad address /
				// non-AggregatorV3 contract) from transient HTTP
				// errors. After 3 reverts we mark the feed
				// unsupported so we stop burning RPC budget on it.
				if isRevert(err) && c.failureCount[s.ChainlinkFeed] >= 3 {
					c.unsupported[s.ChainlinkFeed] = true
					fmt.Printf("[chainlink/%s] feed %s marked unsupported after 3 reverts\n", s.Pair, s.ChainlinkFeed)
				}
				// Rotate RPC on transient errors only.
				if !isRevert(err) {
					c.rpcIdx.Add(1)
				}
				fmt.Printf("[chainlink/%s] err: %v\n", s.Pair, err)
				continue
			}
			c.failureCount[s.ChainlinkFeed] = 0
			// Pass Chainlink's on-chain updatedAt as the SourceTS so
			// the time-aligned deviation calc can snap market prints
			// to this moment instead of comparing against now-fresh
			// values (which would tag Chainlink's heartbeat lag as
			// "deviation" — that artifact is exactly what Fix C kills).
			recordPriceAt(SourceChainlink, s.Pair, price, time.Unix(updatedAt, 0))
			ageS := time.Since(time.Unix(updatedAt, 0)).Seconds()
			if ageS < 0 {
				ageS = 0
			}
			oracleLastRoundAge.WithLabelValues(string(SourceChainlink), string(s.Pair)).Set(ageS)
		}
	}

	tick()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

// read returns (price USD, updatedAt unix seconds, err).
func (c *chainlinkPoller) read(ctx context.Context, feed string) (float64, int64, error) {
	// Fetch decimals first (cached).
	dec, ok := c.decimalsCache[feed]
	if !ok {
		raw, err := c.call(ctx, feed, selDecimals)
		if err != nil {
			return 0, 0, fmt.Errorf("decimals: %w", err)
		}
		bi, err := parseUint(raw)
		if err != nil {
			return 0, 0, fmt.Errorf("decimals decode: %w", err)
		}
		dec = int(bi.Int64())
		c.decimalsCache[feed] = dec
	}

	raw, err := c.call(ctx, feed, selLatestRoundData)
	if err != nil {
		return 0, 0, fmt.Errorf("latestRoundData: %w", err)
	}
	answer, updatedAt, err := decodeLatestRoundData(raw)
	if err != nil {
		return 0, 0, err
	}

	// Scale answer (int256, fixed-point with `dec` decimals) into a
	// float64 USD value. float64 has 15–17 significant digits which
	// is more than enough for the 8-decimal Chainlink feeds.
	scale := new(big.Float).SetInt(pow10(dec))
	priceBF := new(big.Float).Quo(new(big.Float).SetInt(answer), scale)
	price, _ := priceBF.Float64()
	return price, updatedAt, nil
}

func (c *chainlinkPoller) call(ctx context.Context, to, data string) (string, error) {
	body, _ := json.Marshal(rpcReq{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "eth_call",
		Params: []interface{}{
			map[string]string{"to": to, "data": data},
			"latest",
		},
	})
	req, err := http.NewRequestWithContext(ctx, "POST", c.rpcURL(), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("http %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	var r rpcResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", err
	}
	if r.Error != nil {
		return "", fmt.Errorf("rpc %d: %s", r.Error.Code, r.Error.Message)
	}
	if r.Result == "" {
		return "", fmt.Errorf("empty result")
	}
	return r.Result, nil
}

// decodeLatestRoundData unpacks the ABI-encoded 5-tuple. Layout is
// 5 × 32-byte words, fixed offset, no dynamic types.
//
//   word 0: uint80 roundId         (right-padded to 32 bytes)
//   word 1: int256 answer
//   word 2: uint256 startedAt
//   word 3: uint256 updatedAt
//   word 4: uint80 answeredInRound
//
// We only need word 1 (answer, signed) and word 3 (updatedAt).
func decodeLatestRoundData(hexStr string) (*big.Int, int64, error) {
	hexStr = strings.TrimPrefix(hexStr, "0x")
	raw, err := hex.DecodeString(hexStr)
	if err != nil {
		return nil, 0, fmt.Errorf("hex decode: %w", err)
	}
	if len(raw) < 5*32 {
		return nil, 0, fmt.Errorf("short payload: %d bytes", len(raw))
	}
	answer := decodeInt256(raw[32:64])
	updatedAt := new(big.Int).SetBytes(raw[96:128]).Int64()
	return answer, updatedAt, nil
}

// decodeInt256 reads a two's-complement 256-bit signed integer.
// Chainlink prices are always positive in practice, but the field is
// signed so we honor it.
func decodeInt256(b []byte) *big.Int {
	v := new(big.Int).SetBytes(b)
	if len(b) > 0 && b[0]&0x80 != 0 {
		// Negative: subtract 2^256.
		twoExp256 := new(big.Int).Lsh(big.NewInt(1), 256)
		v.Sub(v, twoExp256)
	}
	return v
}

func parseUint(hexStr string) (*big.Int, error) {
	hexStr = strings.TrimPrefix(hexStr, "0x")
	if hexStr == "" {
		return nil, fmt.Errorf("empty hex")
	}
	raw, err := hex.DecodeString(hexStr)
	if err != nil {
		return nil, err
	}
	return new(big.Int).SetBytes(raw), nil
}

func pow10(n int) *big.Int {
	r := big.NewInt(1)
	ten := big.NewInt(10)
	for i := 0; i < n; i++ {
		r.Mul(r, ten)
	}
	return r
}

// isRevert returns true when the RPC error string indicates the
// contract reverted (vs a transport-level failure). We classify by
// substring on the error message; the JSON-RPC error code for revert
// is 3 across all major node implementations (geth, erigon,
// reth, nethermind), so the "rpc 3" substring is a stable marker.
func isRevert(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "execution reverted") || strings.Contains(s, "rpc 3:")
}
