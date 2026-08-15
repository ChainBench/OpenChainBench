package main

// source_gains.go — Gains Network (gTrade) on Base mainnet.
//
// Liquidations: eth_getLogs on the diamond for TradeClosed events, keeping
// only those whose cancelReason (last uint8 word of the event data) == 1.
// Notional = collateralAmount/1e6 * leverage/1e3.
// OI: GET backend-base.gains.trade/trading-variables; find pairIndex from
// pairs[i].from == asset, then sum oiLongCollateral+oiShortCollateral from
// the USDC collateral's pairOis[pairIndex] / 1e6.
//
// Because the only permitted external dependency is the Prometheus client,
// a minimal Keccak-256 (legacy padding, as used for Ethereum event topics)
// is implemented at the bottom of this file.

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"math/bits"
	"strings"
	"sync"
	"time"
)

const (
	gainsDiamond          = "0x6cd5ac19a07518a8092eeffda4f1174c72704eeb"
	gainsTradingVarsURL   = "https://backend-base.gains.trade/trading-variables"

	// ~24h of Base blocks at ~2s block time; also the hard cap on how far
	// back we ever scan (older events fall outside the window anyway).
	gainsInitialLookbackBlocks = 43200

	// Conservative per-request block range for eth_getLogs on public RPC.
	// VERIFY: https://mainnet.base.org getLogs range/result limits; raise if
	// your provider allows larger ranges.
	gainsMaxLogRangeBlocks = 5000

	gainsBlockTimeMs = 2000 // Base ~2s blocks

	// Sanity ceiling on a single decoded liquidation to guard against ABI
	// word-offset mistakes producing nonsense notionals.
	gainsMaxSingleNotionalUSD = 1e10
)

// gainsTradeClosedSig is hashed with Keccak-256 to obtain topic0.
// VERIFY: exact TradeClosed signature against the deployed gains diamond ABI
// on Base (field order inside the tuples in particular).
const gainsTradeClosedSig = "TradeClosed(address,uint32,(address,uint32,bool,uint32,uint16,uint64,uint64),(uint32,uint64,uint64,bool,uint40,uint40),(uint256,int256,uint256,uint256,uint256,uint256,uint256,int256),(uint64,uint64,bool,bool),uint8)"

var gainsTradeClosedTopic = func() string {
	h := keccak256([]byte(gainsTradeClosedSig))
	return "0x" + hex.EncodeToString(h[:])
}()

// gainsPairIndex maps assets to gTrade pair indices on the Base deployment.
// Confirmed from trading-variables: pairs[0].from="BTC", pairs[1].from="ETH".
var gainsPairIndex = map[string]uint64{
	"BTC": 0,
	"ETH": 1,
}

// Assumed word layout of the non-indexed event data. The data is a flat
// sequence of 32-byte words because every tuple member is a static type.
// Counting backwards from the end is robust to whether the two leading
// scalar params (address, uint32) are indexed or inline:
//
//	... [tupleA: 7 words][tupleB: 6 words][tupleC: 8 words][tupleD: 4 words][cancelReason: 1 word]
//
// so tupleA starts at wordCount-26 and cancelReason is the last word.
const gainsTailWords = 26 // 7 + 6 + 8 + 4 + 1

// Offsets within tupleA (address,uint32,bool,uint32,uint16,uint64,uint64).
const (
	// VERIFY: position of pairIndex within the trade tuple in the gains ABI.
	gainsTupleAWordPairIndex = 1
	// VERIFY: position of leverage (1e3 fixed point) within the trade tuple.
	gainsTupleAWordLeverage = 4
	// VERIFY: position of collateralAmount (USDC, 6 decimals) within the
	// trade tuple.
	gainsTupleAWordCollateral = 5
)

const gainsCancelReasonLiquidation = 1

// Gains implements Source via Base JSON-RPC log scanning.
type Gains struct {
	rpcURL          string
	tradingVarsURL  string // defaults to gainsTradingVarsURL

	mu        sync.Mutex
	lastBlock map[string]uint64 // per-asset processed high-water mark
}

// NewGains returns the gains source pointed at the given Base RPC URL.
func NewGains(rpcURL string) *Gains {
	return &Gains{
		rpcURL:         rpcURL,
		tradingVarsURL: gainsTradingVarsURL,
		lastBlock:      make(map[string]uint64),
	}
}

// --- JSON-RPC plumbing ---

type rpcRequest struct {
	Jsonrpc string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
	ID      int    `json:"id"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

func (g *Gains) rpcCall(method string, params []any, out any) error {
	var resp rpcResponse
	if err := httpPostJSON(g.rpcURL, rpcRequest{Jsonrpc: "2.0", Method: method, Params: params, ID: 1}, &resp); err != nil {
		return fmt.Errorf("rpc %s: %w", method, err)
	}
	if resp.Error != nil {
		return fmt.Errorf("rpc %s: code %d: %s", method, resp.Error.Code, resp.Error.Message)
	}
	if out != nil {
		if err := json.Unmarshal(resp.Result, out); err != nil {
			return fmt.Errorf("rpc %s decode: %w", method, err)
		}
	}
	return nil
}

func (g *Gains) latestBlock() (uint64, error) {
	var hexStr string
	if err := g.rpcCall("eth_blockNumber", []any{}, &hexStr); err != nil {
		return 0, err
	}
	return parseHexUint(hexStr)
}

type ethLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	TxHash      string   `json:"transactionHash"`
	LogIndex    string   `json:"logIndex"`
	Removed     bool     `json:"removed"`
}

// FetchLiquidationsSince scans TradeClosed logs from lastBlock+1 (first tick:
// HasLiquidationSource reports true — TradeClosed on-chain logs give full coverage.
func (g *Gains) HasLiquidationSource() bool { return true }

// latest-43200) to latest and returns those decoded as liquidations of the
// requested asset. sinceMs is unused: block cursoring replaces it here.
func (g *Gains) FetchLiquidationsSince(asset string, _ int64) ([]LiqEvent, error) {
	pairIdx, ok := gainsPairIndex[asset]
	if !ok {
		return nil, fmt.Errorf("gains: unsupported asset %q", asset)
	}

	latest, err := g.latestBlock()
	if err != nil {
		return nil, err
	}

	floor := uint64(1)
	if latest > gainsInitialLookbackBlocks {
		floor = latest - gainsInitialLookbackBlocks
	}

	g.mu.Lock()
	from := g.lastBlock[asset] + 1
	if g.lastBlock[asset] == 0 || from < floor {
		// First tick, or we fell behind by more than the window: anything
		// older than 24h would be pruned immediately, so clamp.
		from = floor
	}
	g.mu.Unlock()

	if from > latest {
		return nil, nil
	}

	nowMs := time.Now().UnixMilli()
	var events []LiqEvent

	for start := from; start <= latest; start += gainsMaxLogRangeBlocks {
		end := start + gainsMaxLogRangeBlocks - 1
		if end > latest {
			end = latest
		}
		filter := map[string]any{
			"fromBlock": hexUint(start),
			"toBlock":   hexUint(end),
			"address":   gainsDiamond,
			"topics":    []any{gainsTradeClosedTopic},
		}
		var logs []ethLog
		if err := g.rpcCall("eth_getLogs", []any{filter}, &logs); err != nil {
			return nil, err
		}
		for _, lg := range logs {
			if lg.Removed {
				continue
			}
			ev, matched, decodeErr := decodeGainsTradeClosed(lg, pairIdx, latest, nowMs)
			if decodeErr != nil {
				// A single malformed log should not poison the whole tick;
				// log and continue.
				log.Printf("[gains/%s] skipping undecodable log %s:%s: %v", asset, lg.TxHash, lg.LogIndex, decodeErr)
				continue
			}
			if matched {
				events = append(events, ev)
			}
		}
	}

	// Advance the high-water mark only after the full range succeeded so a
	// failed tick is retried from the same block next time.
	g.mu.Lock()
	if latest > g.lastBlock[asset] {
		g.lastBlock[asset] = latest
	}
	g.mu.Unlock()

	return events, nil
}

// decodeGainsTradeClosed decodes one TradeClosed log and reports whether it
// is a liquidation of the wanted pair.
func decodeGainsTradeClosed(lg ethLog, wantPair uint64, latest uint64, nowMs int64) (LiqEvent, bool, error) {
	data, err := hexBytes(lg.Data)
	if err != nil {
		return LiqEvent{}, false, fmt.Errorf("data hex: %w", err)
	}
	if len(data) == 0 || len(data)%32 != 0 {
		return LiqEvent{}, false, fmt.Errorf("data length %d not word-aligned", len(data))
	}
	words := len(data) / 32
	if words < gainsTailWords {
		return LiqEvent{}, false, fmt.Errorf("data has %d words, expected >= %d", words, gainsTailWords)
	}
	word := func(i int) *big.Int {
		return new(big.Int).SetBytes(data[i*32 : (i+1)*32])
	}

	cancel := word(words - 1)
	if !cancel.IsUint64() || cancel.Uint64() != gainsCancelReasonLiquidation {
		return LiqEvent{}, false, nil // closed for another reason
	}

	base := words - gainsTailWords // first word of tupleA
	pairWord := word(base + gainsTupleAWordPairIndex)
	if !pairWord.IsUint64() {
		return LiqEvent{}, false, fmt.Errorf("pairIndex word not uint64-representable")
	}
	if pairWord.Uint64() != wantPair {
		return LiqEvent{}, false, nil // liquidation of a different pair
	}

	leverage := word(base + gainsTupleAWordLeverage)
	collateral := word(base + gainsTupleAWordCollateral)

	collateralF, _ := new(big.Float).SetInt(collateral).Float64()
	leverageF, _ := new(big.Float).SetInt(leverage).Float64()
	// collateral is USDC (6 decimals); leverage is 1e3 fixed point.
	notional := collateralF / 1e6 * leverageF / 1e3
	if notional <= 0 || notional > gainsMaxSingleNotionalUSD {
		return LiqEvent{}, false, fmt.Errorf("implausible notional %.4f (check ABI word offsets)", notional)
	}

	blockNum, err := parseHexUint(lg.BlockNumber)
	if err != nil {
		return LiqEvent{}, false, fmt.Errorf("blockNumber: %w", err)
	}
	// Approximate the event time from block distance at ~2s per block; Base
	// block times are stable enough for 24h windowing, and this avoids one
	// eth_getBlockByNumber round trip per block.
	var tsMs int64
	if latest >= blockNum {
		tsMs = nowMs - int64(latest-blockNum)*gainsBlockTimeMs
	} else {
		tsMs = nowMs
	}

	return LiqEvent{
		Key:         lg.TxHash + ":" + lg.LogIndex,
		NotionalUSD: notional,
		TimestampMs: tsMs,
	}, true, nil
}

// gainsTV is the subset of the trading-variables response we care about.
type gainsTV struct {
	Pairs []struct {
		From string `json:"from"`
	} `json:"pairs"`
	Collaterals []struct {
		Symbol  string `json:"symbol"`
		PairOis []struct {
			Collateral struct {
				OILong  string `json:"oiLongCollateral"`
				OIShort string `json:"oiShortCollateral"`
			} `json:"collateral"`
		} `json:"pairOis"`
	} `json:"collaterals"`
}

// FetchOI returns open interest in USD from the Gains trading-variables API.
// It finds the pairIndex by matching pairs[i].from == asset, then sums
// oiLongCollateral + oiShortCollateral from the USDC collateral / 1e6.
func (g *Gains) FetchOI(asset string) (float64, error) {
	var tv gainsTV
	if err := httpGetJSON(g.tradingVarsURL, &tv); err != nil {
		return 0, fmt.Errorf("gains trading-variables: %w", err)
	}

	pairIdx := -1
	for i, p := range tv.Pairs {
		if strings.EqualFold(p.From, asset) {
			pairIdx = i
			break
		}
	}
	if pairIdx < 0 {
		return 0, fmt.Errorf("gains: asset %q not found in pairs", asset)
	}

	var totalOI float64
	for _, col := range tv.Collaterals {
		if !strings.EqualFold(col.Symbol, "USDC") {
			continue
		}
		if pairIdx >= len(col.PairOis) {
			return 0, fmt.Errorf("gains: pairIdx %d out of range for collateral %s (len=%d)", pairIdx, col.Symbol, len(col.PairOis))
		}
		oiLong, err := parseF(col.PairOis[pairIdx].Collateral.OILong)
		if err != nil {
			return 0, fmt.Errorf("gains oiLongCollateral: %w", err)
		}
		oiShort, err := parseF(col.PairOis[pairIdx].Collateral.OIShort)
		if err != nil {
			return 0, fmt.Errorf("gains oiShortCollateral: %w", err)
		}
		totalOI += (oiLong + oiShort) / 1e6
	}
	if totalOI == 0 {
		return 0, fmt.Errorf("gains: no USDC collateral OI found for %s", asset)
	}
	return totalOI, nil
}

// --- small hex helpers ---

func hexUint(v uint64) string { return fmt.Sprintf("0x%x", v) }

func parseHexUint(s string) (uint64, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "0x")
	if s == "" {
		return 0, fmt.Errorf("empty hex quantity")
	}
	v, err := strconv64(s)
	if err != nil {
		return 0, fmt.Errorf("parse hex %q: %w", s, err)
	}
	return v, nil
}

// strconv64 is a tiny wrapper kept separate for clarity at call sites.
func strconv64(hexDigits string) (uint64, error) {
	var v uint64
	for _, c := range hexDigits {
		var d uint64
		switch {
		case c >= '0' && c <= '9':
			d = uint64(c - '0')
		case c >= 'a' && c <= 'f':
			d = uint64(c-'a') + 10
		case c >= 'A' && c <= 'F':
			d = uint64(c-'A') + 10
		default:
			return 0, fmt.Errorf("invalid hex digit %q", string(c))
		}
		if v > (^uint64(0))>>4 {
			return 0, fmt.Errorf("hex quantity overflows uint64")
		}
		v = v<<4 | d
	}
	return v, nil
}

func hexBytes(s string) ([]byte, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "0x")
	if len(s)%2 != 0 {
		s = "0" + s
	}
	return hex.DecodeString(s)
}

// --- Keccak-256 (legacy padding, Ethereum-style) ---

var keccakRC = [24]uint64{
	0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
	0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
	0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
	0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
	0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
	0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
}

// keccakRot[x][y] are the rho rotation offsets for lane (x, y), lane index x+5y.
var keccakRot = [5][5]int{
	{0, 36, 3, 41, 18},
	{1, 44, 10, 45, 2},
	{62, 6, 43, 15, 61},
	{28, 55, 25, 21, 56},
	{27, 20, 39, 8, 14},
}

func keccakF(a *[25]uint64) {
	var c, d [5]uint64
	var b [25]uint64
	for round := 0; round < 24; round++ {
		// theta
		for x := 0; x < 5; x++ {
			c[x] = a[x] ^ a[x+5] ^ a[x+10] ^ a[x+15] ^ a[x+20]
		}
		for x := 0; x < 5; x++ {
			d[x] = c[(x+4)%5] ^ bits.RotateLeft64(c[(x+1)%5], 1)
			for y := 0; y < 5; y++ {
				a[x+5*y] ^= d[x]
			}
		}
		// rho + pi
		for x := 0; x < 5; x++ {
			for y := 0; y < 5; y++ {
				b[y+5*((2*x+3*y)%5)] = bits.RotateLeft64(a[x+5*y], keccakRot[x][y])
			}
		}
		// chi
		for x := 0; x < 5; x++ {
			for y := 0; y < 5; y++ {
				a[x+5*y] = b[x+5*y] ^ ((^b[(x+1)%5+5*y]) & b[(x+2)%5+5*y])
			}
		}
		// iota
		a[0] ^= keccakRC[round]
	}
}

// keccak256 computes the original Keccak-256 digest (0x01 padding, as used
// by Ethereum for event topic hashing — not SHA3-256's 0x06 padding).
func keccak256(data []byte) [32]byte {
	const rate = 136 // bytes; 1088-bit rate for 256-bit output
	var st [25]uint64

	absorb := func(block []byte) {
		for i := 0; i < rate/8; i++ {
			st[i] ^= binary.LittleEndian.Uint64(block[i*8:])
		}
		keccakF(&st)
	}

	for len(data) >= rate {
		absorb(data[:rate])
		data = data[rate:]
	}
	var last [rate]byte
	copy(last[:], data)
	last[len(data)] ^= 0x01
	last[rate-1] ^= 0x80
	absorb(last[:])

	var out [32]byte
	for i := 0; i < 4; i++ {
		binary.LittleEndian.PutUint64(out[i*8:], st[i])
	}
	return out
}
