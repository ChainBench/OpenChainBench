package main

// source_gains.go — Gains (gTrade), one instance per deployment chain,
// aggregated by GainsMulti. Until 2026-09-21 only Base was read, where
// Gains holds about $60k of ETH/BTC open interest; Arbitrum holds the
// bulk (about $20M on ETH alone), so the Gains row was measured on a
// deployment that is a rounding error of the venue.
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
	// Base deployment. The Arbitrum diamond (0xFF162c…7f169) is the one the
	// Gains front end reads its close-fee settings from; both run the same
	// gTrade v8 diamond and emit the same TradeClosed event.
	gainsDiamond         = "0x6cd5ac19a07518a8092eeffda4f1174c72704eeb"
	gainsArbitrumDiamond = "0xFF162c694eAA571f685030649814282eA457f169"
	gainsTradingVarsURL  = "https://backend-base.gains.trade/trading-variables"
	gainsArbitrumVarsURL = "https://backend-arbitrum.gains.trade/trading-variables"
	gainsArbitrumBlockMs = 250
	// ~24h of Arbitrum blocks at ~250 ms; scanned in 5k-block windows
	// (about 20 min each), inside the range cap of the keyed RPCs (Chainstack).
	gainsArbitrumLookback = 345600
	gainsArbitrumLogRange = 5000

	// ~24h of Base blocks at ~2s block time; also the hard cap on how far
	// back we ever scan (older events fall outside the window anyway).
	gainsInitialLookbackBlocks = 43200

	// Per-request block range for eth_getLogs. mainnet.base.org caps it at
	// 2,000 blocks (error -32614) since 2026-08; the previous 5,000 made
	// every Base scan fail, so Gains published 0 liquidations for weeks.
	gainsMaxLogRangeBlocks = 2000
	gainsBlockTimeMs       = 2000 // Base ~2s blocks

	// Sanity ceiling on a single decoded liquidation to guard against ABI
	// word-offset mistakes producing nonsense notionals.
	gainsMaxSingleNotionalUSD = 1e10
)

// Liquidations are LimitExecuted events whose orderType is LIQ_CLOSE (6 in
// the gTrade v8 PendingOrderType enum, per @gainsnetwork/sdk). Signature and
// field order come from the GNSMultiCollatDiamond ABI (Gains docs); every
// member is static so the data is a flat word array. Until 2026-09-21 the
// harness listened for a "TradeClosed(...)" shape that the diamond never
// emits with that signature, so Gains published 0 liquidations since launch.
// Current shape (@gainsnetwork/sdk 1.8.10 GNSMultiCollatDiamond ABI): the
// Trade struct carries isCounterTrade / positionSizeToken / __placeholder and
// the price impact is a 6-field tuple.
const gainsLimitExecutedSig = "LimitExecuted((address,uint32),address,uint32,uint32,(address,uint32,uint16,uint24,bool,bool,uint8,uint8,uint120,uint64,uint64,uint64,bool,uint160,uint24),address,uint8,uint256,uint256,uint256,(uint256,int256,int256,int256,int256,uint64),int256,uint256,uint256,bool)"

var gainsLimitExecutedTopic = func() string {
	h := keccak256([]byte(gainsLimitExecutedSig))
	return "0x" + hex.EncodeToString(h[:])
}()

// gainsPairIndex maps assets to gTrade pair indices (same on every
// deployment; confirmed from trading-variables: pairs[0]=BTC, pairs[1]=ETH).
var gainsPairIndex = map[string]uint64{
	"BTC": 0,
	"ETH": 1,
}

// Non-indexed data words of LimitExecuted (user, index, limitIndex are
// indexed topics): orderId (2) | trade t (15) | triggerCaller | orderType |
// oraclePrice | marketPrice | liqPrice | priceImpact (6) | percentProfit |
// amountSentToTrader | collateralPriceUsd | exactExecution = 32 words.
const (
	gainsLimitExecutedWords    = 32
	gainsWordPairIndex         = 4  // t.pairIndex
	gainsWordLeverage          = 5  // t.leverage, 1e3 fixed point
	gainsWordCollateralIndex   = 8  // t.collateralIndex
	gainsWordCollateralAmount  = 10 // t.collateralAmount, collateral decimals
	gainsWordOrderType         = 18
	gainsWordCollateralPriceUS = 30 // 1e8 fixed point
	gainsOrderTypeLiqClose     = 6
)

// Gains implements Source via JSON-RPC log scanning of one deployment.
type Gains struct {
	chain          string
	rpcURL         string
	diamond        string
	tradingVarsURL string
	blockTimeMs    int64
	lookbackBlocks uint64
	maxLogRange    uint64

	mu        sync.Mutex
	lastBlock map[string]uint64 // per-asset processed high-water mark
	// collateralIndex -> decimals, from trading-variables (the index sets
	// differ per deployment: Arbitrum DAI/WETH/USDC/GNS, Base USDC/BtcUSD).
	decimals   map[uint64]int
	decimalsAt time.Time
}

// NewGains returns the Base deployment pointed at the given RPC URL.
func NewGains(rpcURL string) *Gains {
	return &Gains{
		chain:          "base",
		rpcURL:         rpcURL,
		diamond:        gainsDiamond,
		tradingVarsURL: gainsTradingVarsURL,
		blockTimeMs:    gainsBlockTimeMs,
		lookbackBlocks: gainsInitialLookbackBlocks,
		maxLogRange:    gainsMaxLogRangeBlocks,
		lastBlock:      make(map[string]uint64),
	}
}

// NewGainsArbitrum returns the Arbitrum deployment pointed at the given RPC URL.
func NewGainsArbitrum(rpcURL string) *Gains {
	return &Gains{
		chain:          "arbitrum",
		rpcURL:         rpcURL,
		diamond:        gainsArbitrumDiamond,
		tradingVarsURL: gainsArbitrumVarsURL,
		blockTimeMs:    gainsArbitrumBlockMs,
		lookbackBlocks: gainsArbitrumLookback,
		maxLogRange:    gainsArbitrumLogRange,
		lastBlock:      make(map[string]uint64),
	}
}

// GainsMulti sums the deployments: liquidation events concatenated, open
// interest added. One deployment failing fails the tick (retried next
// tick) rather than publishing a partial venue as if it were whole.
type GainsMulti struct {
	chains []*Gains
}

func NewGainsMulti(chains ...*Gains) *GainsMulti { return &GainsMulti{chains: chains} }

func (m *GainsMulti) HasLiquidationSource() bool { return true }

func (m *GainsMulti) FetchLiquidationsSince(asset string, sinceMs int64) ([]LiqEvent, error) {
	var all []LiqEvent
	for _, c := range m.chains {
		evs, err := c.FetchLiquidationsSince(asset, sinceMs)
		if err != nil {
			return nil, fmt.Errorf("gains/%s: %w", c.chain, err)
		}
		all = append(all, evs...)
	}
	return all, nil
}

func (m *GainsMulti) FetchOI(asset string) (float64, error) {
	var total float64
	for _, c := range m.chains {
		oi, err := c.FetchOI(asset)
		if err != nil {
			return 0, fmt.Errorf("gains/%s: %w", c.chain, err)
		}
		total += oi
	}
	return total, nil
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
	if latest > g.lookbackBlocks {
		floor = latest - g.lookbackBlocks
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
	decimals, err := g.collateralDecimals()
	if err != nil {
		return nil, err
	}
	var events []LiqEvent

	for start := from; start <= latest; start += g.maxLogRange {
		end := start + g.maxLogRange - 1
		if end > latest {
			end = latest
		}
		filter := map[string]any{
			"fromBlock": hexUint(start),
			"toBlock":   hexUint(end),
			"address":   g.diamond,
			"topics":    []any{gainsLimitExecutedTopic},
		}
		var logs []ethLog
		if err := g.rpcCall("eth_getLogs", []any{filter}, &logs); err != nil {
			return nil, err
		}
		for _, lg := range logs {
			if lg.Removed {
				continue
			}
			ev, matched, decodeErr := decodeGainsLimitExecuted(lg, pairIdx, latest, nowMs, g.blockTimeMs, decimals)
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

// decodeGainsLimitExecuted decodes one LimitExecuted log and reports whether
// it is a liquidation (orderType LIQ_CLOSE) of the wanted pair. Notional =
// collateralAmount / 10^decimals x leverage / 1e3 x collateralPriceUsd / 1e8.
func decodeGainsLimitExecuted(lg ethLog, wantPair uint64, latest uint64, nowMs int64, blockTimeMs int64, decimals map[uint64]int) (LiqEvent, bool, error) {
	data, err := hexBytes(lg.Data)
	if err != nil {
		return LiqEvent{}, false, fmt.Errorf("data hex: %w", err)
	}
	if len(data) != gainsLimitExecutedWords*32 {
		return LiqEvent{}, false, fmt.Errorf("data has %d bytes, expected %d words", len(data), gainsLimitExecutedWords)
	}
	word := func(i int) *big.Int {
		return new(big.Int).SetBytes(data[i*32 : (i+1)*32])
	}
	orderType := word(gainsWordOrderType)
	if !orderType.IsUint64() || orderType.Uint64() != gainsOrderTypeLiqClose {
		return LiqEvent{}, false, nil // a limit, take-profit or stop-loss execution
	}
	pairWord := word(gainsWordPairIndex)
	if !pairWord.IsUint64() || pairWord.Uint64() != wantPair {
		return LiqEvent{}, false, nil // liquidation of a different pair
	}
	colIdx := word(gainsWordCollateralIndex)
	dec, ok := decimals[colIdx.Uint64()]
	if !ok {
		return LiqEvent{}, false, fmt.Errorf("unknown collateralIndex %s", colIdx)
	}
	leverage := new(big.Float).SetInt(word(gainsWordLeverage))
	collateral := new(big.Float).SetInt(word(gainsWordCollateralAmount))
	price := new(big.Float).SetInt(word(gainsWordCollateralPriceUS))
	scale := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(dec)), nil))
	notional := new(big.Float).Quo(collateral, scale)
	notional.Mul(notional, leverage)
	notional.Quo(notional, big.NewFloat(1e3))
	notional.Mul(notional, price)
	notional.Quo(notional, big.NewFloat(1e8))
	n, _ := notional.Float64()
	if n <= 0 || n > gainsMaxSingleNotionalUSD {
		return LiqEvent{}, false, fmt.Errorf("implausible notional %.2f", n)
	}
	blockNum, err := parseHexUint(lg.BlockNumber)
	if err != nil {
		return LiqEvent{}, false, fmt.Errorf("blockNumber: %w", err)
	}
	tsMs := nowMs
	if blockNum < latest {
		tsMs = nowMs - int64(latest-blockNum)*blockTimeMs
	}
	return LiqEvent{Key: lg.TxHash + ":" + lg.LogIndex, NotionalUSD: n, TimestampMs: tsMs}, true, nil
}

// collateralDecimals reads (and caches for an hour) each collateral's
// decimals from trading-variables.
func (g *Gains) collateralDecimals() (map[uint64]int, error) {
	g.mu.Lock()
	if g.decimals != nil && time.Since(g.decimalsAt) < time.Hour {
		d := g.decimals
		g.mu.Unlock()
		return d, nil
	}
	g.mu.Unlock()
	var tv gainsTV
	if err := httpGetJSON(g.tradingVarsURL, &tv); err != nil {
		return nil, fmt.Errorf("gains trading-variables: %w", err)
	}
	out := make(map[uint64]int, len(tv.Collaterals))
	for _, c := range tv.Collaterals {
		if c.CollateralIndex > 0 && c.Config.Decimals > 0 {
			out[c.CollateralIndex] = c.Config.Decimals
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("gains trading-variables: no collateral decimals")
	}
	g.mu.Lock()
	g.decimals, g.decimalsAt = out, time.Now()
	g.mu.Unlock()
	return out, nil
}

type gainsTV struct {
	Pairs []struct {
		From string `json:"from"`
	} `json:"pairs"`
	Collaterals []struct {
		CollateralIndex uint64 `json:"collateralIndex"`
		Symbol          string `json:"symbol"`
		Prices          struct {
			CollateralPriceUsd float64 `json:"collateralPriceUsd"`
		} `json:"prices"`
		Config struct {
			Decimals int `json:"decimals"`
		} `json:"collateralConfig"`
		PairOis []struct {
			Collateral struct {
				OILong  string `json:"oiLongCollateral"`
				OIShort string `json:"oiShortCollateral"`
			} `json:"collateral"`
		} `json:"pairOis"`
	} `json:"collaterals"`
}

// FetchOI returns the pair's open interest in USD from trading-variables:
// long plus short, summed over every collateral of the deployment, each
// converted with its decimals and its USD price (an OI in WETH or GNS
// collateral counted at face value, or skipped, misstates the venue).
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
		if pairIdx >= len(col.PairOis) || col.Config.Decimals <= 0 || col.Prices.CollateralPriceUsd <= 0 {
			continue
		}
		oiLong, err := parseF(col.PairOis[pairIdx].Collateral.OILong)
		if err != nil {
			return 0, fmt.Errorf("gains oiLongCollateral: %w", err)
		}
		oiShort, err := parseF(col.PairOis[pairIdx].Collateral.OIShort)
		if err != nil {
			return 0, fmt.Errorf("gains oiShortCollateral: %w", err)
		}
		scale := 1.0
		for i := 0; i < col.Config.Decimals; i++ {
			scale *= 10
		}
		totalOI += (oiLong + oiShort) / scale * col.Prices.CollateralPriceUsd
	}
	if totalOI == 0 {
		return 0, fmt.Errorf("gains: no open interest found for %s", asset)
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
