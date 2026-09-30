package main

// source_gains.go: Gains (gTrade), one instance per deployment chain
// (Arbitrum, where the bulk of the open interest sits, and Base), summed by
// GainsMulti into one venue row.
//
// Everything the row needs except open interest comes off one scan of the
// gTrade diamond's execution logs. The diamond emits four events when a
// position changes size, and every one of them carries the pair index and
// enough to price the leg in USD:
//
//   - MarketExecuted: a market open or a market close, full notional.
//   - LimitExecuted: a limit or stop open, a take-profit, stop-loss or
//     liquidation close, full notional. orderType LIQ_CLOSE (6) is the
//     liquidation numerator.
//   - PositionSizeIncreaseExecuted / PositionSizeDecreaseExecuted: a partial
//     resize, at the traded delta.
//
// Each log is one leg of one trade, so the sum over all four is the venue's
// traded notional at the same perimeter the Gains backend's volume-mix uses
// ("opens and closes at full notional, resizes at their traded delta"), and
// the liquidation share is a numerator and a denominator read off the same
// contract by the same decode, the way GMX's are read off one squid.
//
// Notional for a full leg = collateralAmount / 10^decimals x leverage / 1e3
// x collateralPriceUsd / 1e8. For a resize it is positionSizeCollateralDelta
// / 10^decimals x collateralPriceUsd / 1e8.
//
// OI: GET backend-<chain>.gains.trade/trading-variables, oiLongCollateral +
// oiShortCollateral of the pair across every collateral, each at its
// decimals and USD price, summed long plus short (see poolOpenInterest).
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
	// gTrade v8 diamond and emit the same execution events.
	gainsDiamond         = "0x6cd5ac19a07518a8092eeffda4f1174c72704eeb"
	gainsArbitrumDiamond = "0xFF162c694eAA571f685030649814282eA457f169"
	gainsTradingVarsURL  = "https://backend-base.gains.trade/trading-variables"
	gainsArbitrumVarsURL = "https://backend-arbitrum.gains.trade/trading-variables"
	gainsArbitrumBlockMs = 250
	// ~24h of Arbitrum blocks at ~250 ms (measured 267 ms on 2026-09-28, so
	// this reaches a little over a day); scanned in 5k-block windows (about
	// 20 min each), inside the range cap of the keyed RPCs (Chainstack).
	gainsArbitrumLookback = 345600
	gainsArbitrumLogRange = 5000

	// ~24h of Base blocks at ~2s block time; also the hard cap on how far
	// back we ever scan (older events fall outside the window anyway).
	gainsInitialLookbackBlocks = 43200

	// Per-request block range for eth_getLogs. mainnet.base.org caps it at
	// 2,000 blocks (error -32614) since 2026-08; the previous 5,000 made
	// every Base scan fail, so Gains published 0 liquidations for weeks.
	gainsMaxLogRangeBlocks = 2000
	// The floor for the adaptive span: below this a day's scan is too many
	// calls to be worth making.
	gainsMinLogRange = 250
	gainsBlockTimeMs = 2000 // Base ~2s blocks

	// Sanity ceiling on a single decoded leg to guard against ABI
	// word-offset mistakes producing nonsense notionals.
	gainsMaxSingleNotionalUSD = 1e10

	// The ETH and BTC goroutines of one tick both ask for the scan; the
	// second within this interval reuses the first. Between ticks the scan
	// resumes from the block cursor.
	gainsScanTTL = 45 * time.Second
)

// Event signatures from the GNSMultiCollatDiamond ABI (@gainsnetwork/sdk
// 1.8.10). Every member is static so the data is a flat word array. Until
// 2026-09-21 the harness listened for a "TradeClosed(...)" shape that the
// diamond never emits with that signature, so Gains published 0
// liquidations since launch. The Trade struct carries isCounterTrade /
// positionSizeToken / __placeholder and the price impact is a 6-field tuple.
const (
	gainsTradeTuple       = "(address,uint32,uint16,uint24,bool,bool,uint8,uint8,uint120,uint64,uint64,uint64,bool,uint160,uint24)"
	gainsPriceImpactTuple = "(uint256,int256,int256,int256,int256,uint64)"

	gainsLimitExecutedSig  = "LimitExecuted((address,uint32),address,uint32,uint32," + gainsTradeTuple + ",address,uint8,uint256,uint256,uint256," + gainsPriceImpactTuple + ",int256,uint256,uint256,bool)"
	gainsMarketExecutedSig = "MarketExecuted((address,uint32),address,uint32," + gainsTradeTuple + ",bool,uint256,uint256,uint256," + gainsPriceImpactTuple + ",int256,uint256,uint256)"
	gainsIncreaseSig       = "PositionSizeIncreaseExecuted((address,uint32),uint8,uint8,address,uint256,uint256,bool,uint256,uint256,uint256,uint256,(uint256,uint256,uint256,uint256,uint256," + gainsPriceImpactTuple + ",int256,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,uint256))"
	gainsDecreaseSig       = "PositionSizeDecreaseExecuted((address,uint32),uint8,uint8,address,uint256,uint256,bool,uint256,uint256,uint256,uint256,(bool,uint256,uint256,uint256,uint256," + gainsPriceImpactTuple + ",int256,int256,int256,int256,uint256,uint256,int256,int256,uint120,uint24))"
)

func gainsTopic(sig string) string {
	h := keccak256([]byte(sig))
	return "0x" + hex.EncodeToString(h[:])
}

var (
	gainsLimitExecutedTopic  = gainsTopic(gainsLimitExecutedSig)
	gainsMarketExecutedTopic = gainsTopic(gainsMarketExecutedSig)
	gainsIncreaseTopic       = gainsTopic(gainsIncreaseSig)
	gainsDecreaseTopic       = gainsTopic(gainsDecreaseSig)
)

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
//
// MarketExecuted (user, index indexed) puts the same Trade tuple at the same
// offset: orderId (2) | t (15) | open | oraclePrice | marketPrice | liqPrice |
// priceImpact (6) | percentProfit | amountSentToTrader | collateralPriceUsd
// = 30 words.
const (
	gainsLimitExecutedWords    = 32
	gainsMarketExecutedWords   = 30
	gainsWordPairIndex         = 4  // t.pairIndex
	gainsWordLeverage          = 5  // t.leverage, 1e3 fixed point
	gainsWordCollateralIndex   = 8  // t.collateralIndex
	gainsWordCollateralAmount  = 10 // t.collateralAmount, collateral decimals
	gainsWordOpenPrice         = 11 // t.openPrice, 1e10 fixed point
	gainsWordPositionSizeToken = 15 // t.positionSizeToken, 1e18 fixed point
	gainsWordLong              = 6  // t.long
	gainsWordOrderType         = 18 // LimitExecuted only
	// liqPrice, the price the close executed at on a liquidation (the event
	// also carries oraclePrice and marketPrice, equal to it whenever
	// exactExecution is set, which it was on all 886 liquidations measured).
	// Not read by the decode; named so the identity that pins percentProfit
	// can be asserted against the layout rather than against a literal 21.
	gainsWordLiqPrice = 21
	// MarketExecuted's `open` bool, at the offset LimitExecuted uses for
	// triggerCaller. It says whether the leg opened or closed a position,
	// which is what LimitExecuted's orderType says.
	gainsMarketWordOpen        = 17
	gainsWordCollateralPriceUS = 30 // LimitExecuted: 1e8 fixed point
	gainsWordMarketColPriceUSD = 29 // MarketExecuted: 1e8 fixed point
	gainsOrderTypeLiqClose     = 6

	// The three words that make the forfeited-collateral arithmetic. Their
	// offsets fall out of the same tuple walk as the rest: the Trade tuple
	// ends at w16, then triggerCaller, orderType, oraclePrice, marketPrice,
	// liqPrice, the six-field price impact (w22..w27), and these.
	//
	// percentProfit is int256 and signed: negative is the loss the price had
	// taken on the position when it was closed, as a percentage at 1e10 fixed
	// point. Reading it unsigned turns a 65% loss into a number near 2^256.
	// It is the price move times the leverage and nothing else, verified
	// against (liqPrice - openPrice) / openPrice x leverage, signed by t.long,
	// on 120 of 120 real Arbitrum liquidations.
	gainsWordPercentProfit = 28
	// amountSentToTrader is in the collateral's own decimals, like
	// collateralAmount. Zero on every one of 886 liquidations measured over
	// the three days to 2026-09-29, and confirmed against the chain: in
	// 0x427c242f (a 200,227 dollar ETH position at 108x) the three USDC
	// transfers out of the diamond total the collateral exactly and every one
	// of them goes to the vault, none to the trader.
	gainsWordAmountSentToTrader = 29
	// The same two words on MarketExecuted, which has no triggerCaller or
	// orderType, so both sit one word earlier.
	gainsMarketWordPercentProfit      = 27
	gainsMarketWordAmountSentToTrader = 28

	// PositionSizeIncreaseExecuted and PositionSizeDecreaseExecuted
	// (collateralIndex, trader, index indexed): orderId (2) | cancelReason |
	// pairIndex | long | oraclePrice | collateralPriceUsd | collateralDelta |
	// leverageDelta | values (21) = 30 words. In values, the traded delta in
	// collateral units is the first word on an increase and the second on a
	// decrease (the first is isLeverageUpdate). cancelReason 0 is an
	// executed resize; anything else was refused by the contract and moved
	// nothing. Pinned against real logs in source_gains_golden_test.go.
	gainsResizeWords             = 30
	gainsResizeWordCancelReason  = 2
	gainsResizeWordPairIndex     = 3
	gainsResizeWordColPriceUSD   = 6
	gainsResizeWordColDelta      = 7
	gainsResizeWordLevDelta      = 8
	gainsIncreaseWordSizeDelta   = 9
	gainsResizeWordExistingPos   = 10 // increase: values.existingPositionSizeCollateral
	gainsResizeWordNewPos        = 11 // increase: values.newPositionSizeCollateral
	gainsDecreaseWordSizeDelta   = 10
	gainsDecreaseWordExistingPos = 11
	gainsResizeCollateralTopic   = 1

	// The three sizes of an increase are written as exact integers and add
	// up exactly; the slack is for nothing but a rounding unit.
	gainsResizeSumTol = 0.005

	// The event encodes the position twice, both times in collateral units:
	// collateralAmount x leverage, and positionSizeToken x openPrice (the
	// contract stores the size divided by the open price, so multiplying it
	// back returns collateral units for every collateral, stablecoin or
	// not). They are written by the contract independently, so requiring
	// them to agree pins every scale factor in the decode at once. A word
	// offset off by one, or a leverage read at 1e18 instead of 1e3, moves
	// one side by orders of magnitude and the log is refused rather than
	// published. The two agreed to 0.01% on the golden USDC liquidation and
	// to the unit on a real WETH-collateral ETH leg, so the tolerance is
	// slack enough for the fee accrual that separates them.
	gainsSizeCrossCheckTol = 0.05
)

// gainsExecKind names which diamond event a decoded leg came from.
type gainsExecKind string

const (
	gainsKindLimit    gainsExecKind = "limit"
	gainsKindMarket   gainsExecKind = "market"
	gainsKindIncrease gainsExecKind = "increase"
	gainsKindDecrease gainsExecKind = "decrease"
)

// gainsExecution is one decoded leg: one open, close or resize of one
// position, priced in USD at execution.
type gainsExecution struct {
	key         string // tx:logIndex
	block       uint64
	tsMs        int64
	pair        uint64
	notionalUSD float64
	liquidation bool
	kind        gainsExecKind
	// collateralUSD and leverage are set on a full leg (the Trade tuple
	// carries both); a resize log carries only its delta.
	collateralUSD float64
	leverage      float64
	// lossAtTriggerPct is the price loss on the position when it was closed,
	// as a percentage of the margin behind it, loss positive. hasForfeit is
	// false for a leg the arithmetic does not describe: a resize, which
	// carries no percentProfit, or a forced close whose price return was
	// *positive*, of which there were 10 in 886 over three days (the largest
	// a long on pair 482 up 8.88% at 52.88x, closed as LIQ_CLOSE with nothing
	// returned). Those are real logs and they are not a trader losing money
	// to a move, so they publish in the notional and stay out of this.
	hasForfeit       bool
	lossAtTriggerPct float64
	returnedUSD      float64
	// isClose marks a leg that closed a position rather than opening one. The
	// margin behind every close is the denominator of
	// perp_liq_margin_destroyed_share_pct, and an open would double it.
	isClose bool
	// collateralIndex and the price the contract stamped on the event, which
	// together make a historical price series for valuing past open interest
	// at the price of its own day rather than at today's.
	collateralIndex    uint64
	collateralPriceUSD float64
}

// Gains implements Source via JSON-RPC log scanning of one deployment.
type Gains struct {
	chain          string
	rpcURL         string
	diamond        string
	tradingVarsURL string
	blockTimeMs    int64
	lookbackBlocks uint64
	maxLogRange    uint64

	// scanMu is held for the whole of a scan so the asset goroutines of one
	// tick page the chain once between them.
	scanMu sync.Mutex

	mu        sync.Mutex
	cursor    uint64 // last block folded into execs, shared by every asset
	execs     []gainsExecution
	oiEvents  []gainsOiEvent // the diamond's own post-state record of the book
	scannedAt time.Time
	// logRange is the span eth_getLogs actually accepts here, probed down
	// from maxLogRange and remembered. The caps differ by endpoint and by
	// filter: a keyed Arbitrum endpoint refused this harness's 5,000 for the
	// open-interest filter and took about 3,125, so the span cannot be a
	// constant per chain.
	logRange uint64
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
	}
}

// GainsMulti sums the deployments: liquidation events concatenated, open
// interest and traded notional added. One deployment failing fails the
// tick (retried next tick) rather than publishing a partial venue as if it
// were whole.
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

// FetchVolume24hUSD is the venue's traded notional on the asset over the
// trailing 24h, summed across the deployments.
func (m *GainsMulti) FetchVolume24hUSD(asset string) (float64, error) {
	var total float64
	for _, c := range m.chains {
		v, err := c.FetchVolume24hUSD(asset)
		if err != nil {
			return 0, fmt.Errorf("gains/%s: %w", c.chain, err)
		}
		total += v
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

// blockTimestampMs reads one block header's timestamp.
func (g *Gains) blockTimestampMs(block uint64) (int64, error) {
	var hdr struct {
		Timestamp string `json:"timestamp"`
	}
	if err := g.rpcCall("eth_getBlockByNumber", []any{hexUint(block), false}, &hdr); err != nil {
		return 0, err
	}
	sec, err := parseHexUint(hdr.Timestamp)
	if err != nil {
		return 0, fmt.Errorf("block %d timestamp: %w", block, err)
	}
	return int64(sec) * 1000, nil
}

// blockClock returns a function placing any block in [from, latest] on the
// wall clock by linear interpolation between the two headers. Arbitrum's
// nominal 250 ms is a target, not a fact (267 ms measured on 2026-09-28),
// and over a day's scan the drift moves legs across the window edge; two
// header reads pin both ends.
func (g *Gains) blockClock(from, latest uint64) (func(uint64) int64, error) {
	latestMs, err := g.blockTimestampMs(latest)
	if err != nil {
		return nil, err
	}
	if from >= latest {
		return func(uint64) int64 { return latestMs }, nil
	}
	fromMs, err := g.blockTimestampMs(from)
	if err != nil {
		return nil, err
	}
	span := float64(latest - from)
	return func(b uint64) int64 {
		if b >= latest {
			return latestMs
		}
		if b <= from {
			return fromMs
		}
		return fromMs + int64(float64(latestMs-fromMs)*float64(b-from)/span)
	}, nil
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

// HasLiquidationSource reports true: the diamond's LimitExecuted logs carry
// every liquidation the venue executes.
func (g *Gains) HasLiquidationSource() bool { return true }

// scan folds the diamond's execution logs from the cursor to the chain head
// into the trailing buffer. It is the one chain read behind both the
// liquidation numerator and the traded-notional denominator; a caller within
// gainsScanTTL of the last successful scan gets that scan.
func (g *Gains) scan() error {
	g.scanMu.Lock()
	defer g.scanMu.Unlock()

	g.mu.Lock()
	if g.logRange == 0 {
		g.logRange = g.maxLogRange
	}
	fresh := !g.scannedAt.IsZero() && time.Since(g.scannedAt) < gainsScanTTL
	cursor := g.cursor
	g.mu.Unlock()
	if fresh {
		return nil
	}

	latest, err := g.latestBlock()
	if err != nil {
		return err
	}
	floor := uint64(1)
	if latest > g.lookbackBlocks {
		floor = latest - g.lookbackBlocks
	}
	from := cursor + 1
	if cursor == 0 || from < floor {
		// First scan, or we fell behind by more than the window: anything
		// older than the window would be pruned immediately, so clamp.
		from = floor
	}
	now := time.Now()
	if from > latest {
		g.mu.Lock()
		g.scannedAt = now
		g.mu.Unlock()
		return nil
	}
	return g.foldRange(from, latest, now, true)
}

// scanRange folds an explicit block range into the buffer without moving the
// cursor or pruning, so a past window can be audited against the venue's own
// figure for the same window. Used by the live audit test only.
func (g *Gains) scanRange(from, to uint64) error {
	return g.foldRange(from, to, time.Now(), false)
}

// foldRange reads the diamond's execution logs over [from, to] and folds them
// into the buffer. commit moves the cursor, prunes the window and stamps the
// scan; an audit of a past range does none of that.
func (g *Gains) foldRange(from, latest uint64, now time.Time, commit bool) error {
	decimals, err := g.collateralDecimals()
	if err != nil {
		return err
	}
	clock, err := g.blockClock(from, latest)
	if err != nil {
		return err
	}

	var found []gainsExecution
	var foundOi []gainsOiEvent
	for start := from; start <= latest; {
		span := g.currentLogRange()
		end := start + span - 1
		if end > latest {
			end = latest
		}
		filter := map[string]any{
			"fromBlock": hexUint(start),
			"toBlock":   hexUint(end),
			"address":   g.diamond,
			"topics": []any{[]string{
				gainsLimitExecutedTopic, gainsMarketExecutedTopic, gainsIncreaseTopic, gainsDecreaseTopic,
				gainsPairOiTopic,
			}},
		}
		var logs []ethLog
		if err := g.rpcCall("eth_getLogs", []any{filter}, &logs); err != nil {
			// A range the endpoint will not serve is not a failure to report,
			// it is a span to stop asking for. Halve and retry the same start.
			if isRangeTooWide(err) && span > gainsMinLogRange {
				next := span / 2
				if next < gainsMinLogRange {
					next = gainsMinLogRange
				}
				g.setLogRange(next)
				log.Printf("[gains/%s] %s refused a %d-block getLogs; using %d", g.chain, "endpoint", span, next)
				continue
			}
			return err
		}
		start = end + 1
		for _, lg := range logs {
			if lg.Removed {
				continue
			}
			// The open-interest events are the venue's own post-state record
			// of the book, and they come off this same scan.
			if len(lg.Topics) > 0 && strings.EqualFold(lg.Topics[0], gainsPairOiTopic) {
				oiEv, oiErr := decodeGainsPairOi(lg)
				if oiErr != nil {
					log.Printf("[gains/%s] skipping undecodable oi log %s:%s: %v", g.chain, lg.TxHash, lg.LogIndex, oiErr)
					continue
				}
				oiEv.tsMs = clock(oiEv.block)
				foundOi = append(foundOi, oiEv)
				continue
			}
			ex, ok, decodeErr := decodeGainsExecution(lg, decimals)
			if decodeErr != nil {
				// A single malformed log should not poison the whole tick;
				// log and continue.
				log.Printf("[gains/%s] skipping undecodable log %s:%s: %v", g.chain, lg.TxHash, lg.LogIndex, decodeErr)
				continue
			}
			if !ok {
				continue
			}
			ex.tsMs = clock(ex.block)
			found = append(found, ex)
		}
	}

	// Commit only after the full range succeeded, so a failed scan is
	// retried from the same cursor next time. The buffer keeps the window
	// plus the runner's fetch overlap; the runner drops anything older.
	g.mu.Lock()
	defer g.mu.Unlock()
	if !commit {
		// An audit of a past range: keep what it read and touch nothing else.
		g.execs = append(g.execs, found...)
		g.oiEvents = append(g.oiEvents, foundOi...)
		return nil
	}
	keepFromMs := now.Add(-(windowSpan + liqFetchOverlap)).UnixMilli()
	kept := g.execs[:0]
	for _, e := range g.execs {
		if e.tsMs >= keepFromMs {
			kept = append(kept, e)
		}
	}
	for i := len(kept); i < len(g.execs); i++ {
		g.execs[i] = gainsExecution{}
	}
	g.execs = append(kept, found...)
	keptOi := g.oiEvents[:0]
	for _, e := range g.oiEvents {
		if e.tsMs >= keepFromMs {
			keptOi = append(keptOi, e)
		}
	}
	for i := len(keptOi); i < len(g.oiEvents); i++ {
		g.oiEvents[i] = gainsOiEvent{}
	}
	g.oiEvents = append(keptOi, foundOi...)
	if latest > g.cursor {
		g.cursor = latest
	}
	g.scannedAt = now
	return nil
}

// currentLogRange is the span this deployment's endpoint is known to accept.
func (g *Gains) currentLogRange() uint64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.logRange == 0 {
		return g.maxLogRange
	}
	return g.logRange
}

func (g *Gains) setLogRange(n uint64) {
	g.mu.Lock()
	g.logRange = n
	g.mu.Unlock()
}

// FetchLiquidationsSince returns the liquidations of the asset held in the
// scan buffer. sinceMs is unused: block cursoring replaces it here, and the
// runner's SeenSet absorbs the legs it has already counted.
func (g *Gains) FetchLiquidationsSince(asset string, _ int64) ([]LiqEvent, error) {
	pairIdx, ok := gainsPairIndex[asset]
	if !ok {
		return nil, fmt.Errorf("gains: unsupported asset %q", asset)
	}
	if err := g.scan(); err != nil {
		return nil, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	var events []LiqEvent
	for _, e := range g.execs {
		if !e.liquidation || e.pair != pairIdx {
			continue
		}
		events = append(events, LiqEvent{Key: e.key, NotionalUSD: e.notionalUSD, TimestampMs: e.tsMs,
			CollateralUSD: e.collateralUSD, Leverage: e.leverage,
			HasForfeitDetail: e.hasForfeit, LossAtTriggerPct: e.lossAtTriggerPct,
			ReturnedUSD: e.returnedUSD})
	}
	return events, nil
}

// FetchVolume24hUSD sums every leg of the asset executed in the trailing
// 24h: opens and closes at full notional, resizes at their traded delta.
func (g *Gains) FetchVolume24hUSD(asset string) (float64, error) {
	pairIdx, ok := gainsPairIndex[asset]
	if !ok {
		return 0, fmt.Errorf("gains: unsupported asset %q", asset)
	}
	if err := g.scan(); err != nil {
		return 0, err
	}
	cutoff := time.Now().Add(-windowSpan).UnixMilli()
	g.mu.Lock()
	defer g.mu.Unlock()
	var total float64
	for _, e := range g.execs {
		if e.pair == pairIdx && e.tsMs >= cutoff {
			total += e.notionalUSD
		}
	}
	return total, nil
}

// decodeGainsExecution decodes one diamond log by its topic into a priced
// leg. ok is false for a log that is a valid event but not a traded leg (a
// refused resize); an error is a log the layout does not explain.
func decodeGainsExecution(lg ethLog, decimals map[uint64]int) (gainsExecution, bool, error) {
	if len(lg.Topics) == 0 {
		return gainsExecution{}, false, fmt.Errorf("log has no topics")
	}
	switch strings.ToLower(lg.Topics[0]) {
	case gainsLimitExecutedTopic:
		return decodeGainsTradeLeg(lg, gainsKindLimit, decimals)
	case gainsMarketExecutedTopic:
		return decodeGainsTradeLeg(lg, gainsKindMarket, decimals)
	case gainsIncreaseTopic:
		return decodeGainsResize(lg, gainsKindIncrease, decimals)
	case gainsDecreaseTopic:
		return decodeGainsResize(lg, gainsKindDecrease, decimals)
	}
	return gainsExecution{}, false, fmt.Errorf("unknown topic %s", lg.Topics[0])
}

// decodeGainsLimitExecuted decodes one LimitExecuted log and reports whether
// it is a liquidation (orderType LIQ_CLOSE) of the wanted pair, with its
// timestamp estimated from the block distance to latest at the nominal block
// time. Kept as the entry point the decode tests pin the word offsets
// through; the scan uses decodeGainsExecution and a header-anchored clock.
func decodeGainsLimitExecuted(lg ethLog, wantPair uint64, latest uint64, nowMs int64, blockTimeMs int64, decimals map[uint64]int) (LiqEvent, bool, error) {
	ex, ok, err := decodeGainsTradeLeg(lg, gainsKindLimit, decimals)
	if err != nil || !ok {
		return LiqEvent{}, false, err
	}
	if !ex.liquidation || ex.pair != wantPair {
		return LiqEvent{}, false, nil
	}
	tsMs := nowMs
	if ex.block < latest {
		tsMs = nowMs - int64(latest-ex.block)*blockTimeMs
	}
	return LiqEvent{Key: ex.key, NotionalUSD: ex.notionalUSD, TimestampMs: tsMs,
		CollateralUSD: ex.collateralUSD, Leverage: ex.leverage,
		HasForfeitDetail: ex.hasForfeit, LossAtTriggerPct: ex.lossAtTriggerPct,
		ReturnedUSD: ex.returnedUSD}, true, nil
}

// decodeGainsTradeLeg decodes a LimitExecuted or MarketExecuted log: a full
// open or close carrying the Trade tuple. Notional = collateralAmount /
// 10^decimals x leverage / 1e3 x collateralPriceUsd / 1e8.
func decodeGainsTradeLeg(lg ethLog, kind gainsExecKind, decimals map[uint64]int) (gainsExecution, bool, error) {
	data, err := hexBytes(lg.Data)
	if err != nil {
		return gainsExecution{}, false, fmt.Errorf("data hex: %w", err)
	}
	wantWords, colPriceWord := gainsLimitExecutedWords, gainsWordCollateralPriceUS
	pctWord, sentWord := gainsWordPercentProfit, gainsWordAmountSentToTrader
	if kind == gainsKindMarket {
		wantWords, colPriceWord = gainsMarketExecutedWords, gainsWordMarketColPriceUSD
		pctWord, sentWord = gainsMarketWordPercentProfit, gainsMarketWordAmountSentToTrader
	}
	if len(data) != wantWords*32 {
		return gainsExecution{}, false, fmt.Errorf("data has %d bytes, expected %d words", len(data), wantWords)
	}
	word := func(i int) *big.Int {
		return new(big.Int).SetBytes(data[i*32 : (i+1)*32])
	}
	// percentProfit is declared int256, so its word is two's complement.
	signedWord := func(i int) *big.Int {
		v := word(i)
		if v.Bit(255) == 1 {
			return new(big.Int).Sub(v, new(big.Int).Lsh(big.NewInt(1), 256))
		}
		return v
	}
	liquidation := false
	if kind == gainsKindLimit {
		orderType := word(gainsWordOrderType)
		liquidation = orderType.IsUint64() && orderType.Uint64() == gainsOrderTypeLiqClose
	}
	pairWord := word(gainsWordPairIndex)
	if !pairWord.IsUint64() {
		return gainsExecution{}, false, fmt.Errorf("pairIndex word out of range")
	}
	colIdx := word(gainsWordCollateralIndex)
	dec, ok := decimals[colIdx.Uint64()]
	if !ok {
		return gainsExecution{}, false, fmt.Errorf("unknown collateralIndex %s", colIdx)
	}
	leverage := new(big.Float).SetInt(word(gainsWordLeverage))
	collateral := new(big.Float).SetInt(word(gainsWordCollateralAmount))
	price := new(big.Float).SetInt(word(colPriceWord))
	scale := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(dec)), nil))
	// The position size in collateral units: collateralAmount x leverage.
	sizeCol := new(big.Float).Quo(collateral, scale)
	sizeCol.Mul(sizeCol, leverage)
	sizeCol.Quo(sizeCol, big.NewFloat(1e3))
	sizeColF, _ := sizeCol.Float64()

	// Second, independent reading of the same position size, also in
	// collateral units: the contract writes positionSizeToken as the size
	// divided by the open price, so multiplying the two back gives the
	// position in collateral units whatever the collateral is. A zero here
	// is itself a refusal: it means the size or price word is not where the
	// layout says, which is exactly the drift the check exists to catch.
	sizeToken := new(big.Float).Quo(new(big.Float).SetInt(word(gainsWordPositionSizeToken)), big.NewFloat(1e18))
	openPrice := new(big.Float).Quo(new(big.Float).SetInt(word(gainsWordOpenPrice)), big.NewFloat(1e10))
	alt, _ := new(big.Float).Mul(sizeToken, openPrice).Float64()
	if alt <= 0 {
		return gainsExecution{}, false, fmt.Errorf("position size cross-check unavailable: positionSizeToken x openPrice = %.2f", alt)
	}
	// Both sides are in collateral units, so the collateral's USD price
	// cancels and one tolerance covers every collateral. Comparing the USD
	// figure against the collateral-unit one instead, as this did until
	// 2026-09-28, refused every WETH-collateral leg by a factor of the ETH
	// price: 56 real legs in 24h, including ETH ones this bench publishes.
	diff := (sizeColF - alt) / alt
	if diff < 0 {
		diff = -diff
	}
	if diff > gainsSizeCrossCheckTol {
		return gainsExecution{}, false, fmt.Errorf(
			"position size disagrees: collateral x leverage = %.6f, positionSizeToken x openPrice = %.6f (%.1f%% apart, both in collateral units)",
			sizeColF, alt, diff*100)
	}

	// USD only now that the size is agreed, at the collateral's price on
	// execution.
	notional := new(big.Float).Mul(sizeCol, price)
	notional.Quo(notional, big.NewFloat(1e8))
	n, _ := notional.Float64()
	if n <= 0 || n > gainsMaxSingleNotionalUSD {
		return gainsExecution{}, false, fmt.Errorf("implausible notional %.2f", n)
	}
	blockNum, err := parseHexUint(lg.BlockNumber)
	if err != nil {
		return gainsExecution{}, false, fmt.Errorf("blockNumber: %w", err)
	}
	// The margin behind the position in USD, and the leverage as a plain
	// multiple: the two figures that say what the notional means.
	colUSD, _ := new(big.Float).Quo(new(big.Float).Mul(new(big.Float).Quo(collateral, scale), price), big.NewFloat(1e8)).Float64()
	lev, _ := new(big.Float).Quo(leverage, big.NewFloat(1e3)).Float64()
	colPxUSD, _ := new(big.Float).Quo(price, big.NewFloat(1e8)).Float64()

	// What the close cost the trader: the price loss the contract stamped on
	// the event, and what it sent back. percentProfit is signed and negative
	// on a loss, so the loss is its negation.
	pct, _ := new(big.Float).Quo(new(big.Float).SetInt(signedWord(pctWord)), big.NewFloat(1e10)).Float64()
	sentUSD, _ := new(big.Float).Quo(
		new(big.Float).Mul(new(big.Float).Quo(new(big.Float).SetInt(word(sentWord)), scale), price),
		big.NewFloat(1e8)).Float64()
	// The forfeited arithmetic only describes a *close*. On an open,
	// percentProfit and amountSentToTrader are both zero, which would read as a
	// position that lost nothing and got nothing back: a forfeit of 100 points.
	// Only liquidations reach the window today, so this is belt and braces, and
	// it is the belt that matters if a later change publishes stop losses too.
	isClose := false
	switch kind {
	case gainsKindLimit:
		// TP_CLOSE (4), SL_CLOSE (5) and LIQ_CLOSE (6), and only those: the
		// enum continues into UPDATE_LEVERAGE (7) and MARKET_PARTIAL_OPEN (8),
		// so an open bound would let an open back through the guard that
		// exists to keep opens out.
		ot := word(gainsWordOrderType)
		if ot.IsUint64() {
			v := ot.Uint64()
			isClose = v >= 4 && v <= gainsOrderTypeLiqClose
		}
	case gainsKindMarket:
		isClose = word(gainsMarketWordOpen).Sign() == 0
	}
	// A forced close whose price return was positive is not a trader losing
	// money to a move, whatever the contract labelled it, so it does not enter
	// the forfeited arithmetic. Everything else about the leg still publishes.
	hasForfeit := isClose && colUSD > 0 && pct <= 0
	return gainsExecution{
		key:                lg.TxHash + ":" + lg.LogIndex,
		block:              blockNum,
		pair:               pairWord.Uint64(),
		notionalUSD:        n,
		liquidation:        liquidation,
		kind:               kind,
		collateralUSD:      colUSD,
		leverage:           lev,
		hasForfeit:         hasForfeit,
		lossAtTriggerPct:   -pct,
		returnedUSD:        sentUSD,
		isClose:            isClose,
		collateralIndex:    colIdx.Uint64(),
		collateralPriceUSD: colPxUSD,
	}, true, nil
}

// decodeGainsResize decodes a PositionSizeIncreaseExecuted or
// PositionSizeDecreaseExecuted log into the traded delta of the resize.
// Notional = positionSizeCollateralDelta / 10^decimals x collateralPriceUsd
// / 1e8. A non-zero cancelReason is a resize the contract refused: no leg
// traded, so ok is false.
func decodeGainsResize(lg ethLog, kind gainsExecKind, decimals map[uint64]int) (gainsExecution, bool, error) {
	data, err := hexBytes(lg.Data)
	if err != nil {
		return gainsExecution{}, false, fmt.Errorf("data hex: %w", err)
	}
	if len(data) != gainsResizeWords*32 {
		return gainsExecution{}, false, fmt.Errorf("data has %d bytes, expected %d words", len(data), gainsResizeWords)
	}
	if len(lg.Topics) <= gainsResizeCollateralTopic {
		return gainsExecution{}, false, fmt.Errorf("resize log has %d topics, expected 4", len(lg.Topics))
	}
	word := func(i int) *big.Int {
		return new(big.Int).SetBytes(data[i*32 : (i+1)*32])
	}
	if word(gainsResizeWordCancelReason).Sign() != 0 {
		return gainsExecution{}, false, nil
	}
	pairWord := word(gainsResizeWordPairIndex)
	if !pairWord.IsUint64() {
		return gainsExecution{}, false, fmt.Errorf("pairIndex word out of range")
	}
	colBytes, err := hexBytes(lg.Topics[gainsResizeCollateralTopic])
	if err != nil {
		return gainsExecution{}, false, fmt.Errorf("collateralIndex topic: %w", err)
	}
	colIdx := new(big.Int).SetBytes(colBytes)
	dec, ok := decimals[colIdx.Uint64()]
	if !ok {
		return gainsExecution{}, false, fmt.Errorf("unknown collateralIndex %s", colIdx)
	}
	deltaWord := gainsIncreaseWordSizeDelta
	if kind == gainsKindDecrease {
		deltaWord = gainsDecreaseWordSizeDelta
	}
	delta := word(deltaWord)
	if delta.Sign() == 0 {
		return gainsExecution{}, false, nil
	}
	switch kind {
	case gainsKindIncrease:
		// The contract writes the three sizes of an increase next to each
		// other and they add up exactly: delta plus existing equals new.
		// That is an invariant of the event rather than an assumption about
		// fees, so it pins the three word offsets hard, the way the Trade
		// tuple's second encoding of position size pins that layout.
		//
		// The first version of this check required the delta to equal
		// collateralDelta x leverageDelta / 1e3, which is not an invariant:
		// a resize that changes collateral and leverage at once, or adds
		// leverage with no collateral, breaks it. On the first deploy that
		// refused 16 real resizes on Base and Arbitrum, by up to 842%, and
		// their notional went missing from the venue's traded total.
		existing, updated := word(gainsResizeWordExistingPos), word(gainsResizeWordNewPos)
		if existing.Sign() > 0 && updated.Sign() > 0 {
			sum := new(big.Int).Add(delta, existing)
			sf, _ := new(big.Float).SetInt(sum).Float64()
			nf, _ := new(big.Float).SetInt(updated).Float64()
			if diff := (sf - nf) / nf; diff > gainsResizeSumTol || diff < -gainsResizeSumTol {
				return gainsExecution{}, false, fmt.Errorf(
					"resize sizes do not add up: delta plus existing = %.0f, new = %.0f", sf, nf)
			}
		}
	case gainsKindDecrease:
		// A decrease cannot trade more than the position held.
		if existing := word(gainsDecreaseWordExistingPos); existing.Sign() > 0 && delta.Cmp(existing) > 0 {
			return gainsExecution{}, false, fmt.Errorf(
				"resize delta %s exceeds the existing position %s", delta, existing)
		}
	}
	scale := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(dec)), nil))
	notional := new(big.Float).Quo(new(big.Float).SetInt(delta), scale)
	notional.Mul(notional, new(big.Float).SetInt(word(gainsResizeWordColPriceUSD)))
	notional.Quo(notional, big.NewFloat(1e8))
	n, _ := notional.Float64()
	if n <= 0 || n > gainsMaxSingleNotionalUSD {
		return gainsExecution{}, false, fmt.Errorf("implausible resize notional %.2f", n)
	}
	blockNum, err := parseHexUint(lg.BlockNumber)
	if err != nil {
		return gainsExecution{}, false, fmt.Errorf("blockNumber: %w", err)
	}
	resizePx, _ := new(big.Float).Quo(new(big.Float).SetInt(word(gainsResizeWordColPriceUSD)), big.NewFloat(1e8)).Float64()
	return gainsExecution{
		key:                lg.TxHash + ":" + lg.LogIndex,
		block:              blockNum,
		pair:               pairWord.Uint64(),
		notionalUSD:        n,
		kind:               kind,
		collateralIndex:    colIdx.Uint64(),
		collateralPriceUSD: resizePx,
	}, true, nil
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
	var long, short float64
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
		long += oiLong / scale * col.Prices.CollateralPriceUsd
		short += oiShort / scale * col.Prices.CollateralPriceUsd
	}
	totalOI := poolOpenInterest(long, short)
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
// by Ethereum for event topic hashing, not SHA3-256's 0x06 padding).
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

// CarriesPositionDetail reports true: the Trade tuple on every LimitExecuted and
// MarketExecuted log carries the margin, and the event carries percentProfit and
// amountSentToTrader beside it.
func (g *Gains) CarriesPositionDetail() bool { return true }

// CarriesPositionDetail reports true when every deployment does, which is both
// of them: they run the same diamond and emit the same events.
func (m *GainsMulti) CarriesPositionDetail() bool {
	for _, c := range m.chains {
		if !c.CarriesPositionDetail() {
			return false
		}
	}
	return len(m.chains) > 0
}

// FetchMarginClosed24hUSD sums the margin behind every position this deployment
// closed on the asset in the trailing 24h: the take profits, stop losses,
// liquidations and market closes already decoded by the same scan the numerator
// comes from. Resizes carry a traded delta and no margin, so they are absent by
// construction rather than excluded.
func (g *Gains) FetchMarginClosed24hUSD(asset string) (float64, error) {
	pairIdx, ok := gainsPairIndex[asset]
	if !ok {
		return 0, fmt.Errorf("gains: unsupported asset %q", asset)
	}
	if err := g.scan(); err != nil {
		return 0, err
	}
	cutoff := time.Now().Add(-windowSpan).UnixMilli()
	g.mu.Lock()
	defer g.mu.Unlock()
	var total float64
	for _, e := range g.execs {
		if e.pair == pairIdx && e.tsMs >= cutoff && e.isClose && e.collateralUSD > 0 {
			total += e.collateralUSD
		}
	}
	return total, nil
}

// FetchMarginClosed24hUSD sums the deployments, as every other Gains figure does.
func (m *GainsMulti) FetchMarginClosed24hUSD(asset string) (float64, error) {
	var total float64
	for _, c := range m.chains {
		v, err := c.FetchMarginClosed24hUSD(asset)
		if err != nil {
			return 0, fmt.Errorf("gains/%s: %w", c.chain, err)
		}
		total += v
	}
	return total, nil
}
