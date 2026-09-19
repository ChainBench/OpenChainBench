package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"time"
)

// EVM native-transfer fee sampler.
//
// Uses eth_feeHistory to get the last 4 blocks of base_fee and the
// configured priority percentiles (25 / 50 / 90). Computes:
//
//   fee_wei[tier] = (latest_base_fee + reward[tier]) * 21000
//
// Standard ETH transfer costs 21000 gas. Same for BNB/Avalanche which run
// the same EVM. Result fed through nativeToUSD() in main.go.
//
// Some chains may not implement eth_feeHistory (older clients) — fallback
// is eth_gasPrice * 21000 emitted under the "std" tier only.

const evmGasNativeTransfer = 21000

type evmFetcher struct {
	http *http.Client
}

func init() {
	// 15 s ceiling. 8 s used to hit hard on BNB (publicnode bsc-rpc went
	// over the 8 s budget often enough to spike tx_fee_fetch_errors_total{
	// chain="bnb",error_type="timeout"} to ~1.4 k/day). 15 s smooths the
	// transient slow-paths without masking real outages: a healthy BNB
	// eth_feeHistory call lands in ~120 ms, so a hung connection still
	// gets caught well within the next probe cycle.
	registerFetcher(KindEVM, &evmFetcher{http: &http.Client{Timeout: 15 * time.Second}})
}

type jsonRPCReq struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
	ID      int    `json:"id"`
}

type feeHistoryResp struct {
	JSONRPC string `json:"jsonrpc"`
	Result  struct {
		OldestBlock   string     `json:"oldestBlock"`
		BaseFeePerGas []string   `json:"baseFeePerGas"`
		GasUsedRatio  []float64  `json:"gasUsedRatio"`
		Reward        [][]string `json:"reward"`
	} `json:"result"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type gasPriceResp struct {
	JSONRPC string `json:"jsonrpc"`
	Result  string `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (f *evmFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	// Try eth_feeHistory first (EIP-1559 — works on Eth, BNB post-Cancun, Avax C-chain).
	samples, err := f.sampleFeeHistory(ch)
	if err == nil && len(samples) > 0 {
		return f.addL1Fee(ch, samples)
	}
	// Fallback to eth_gasPrice (legacy) for chains that don't support feeHistory.
	gp, err2 := f.callGasPrice(ch.RPCURL)
	if err2 != nil {
		if err != nil {
			return nil, fmt.Errorf("feeHistory failed (%v) and gasPrice fallback failed (%v)", err, err2)
		}
		return nil, err2
	}
	feeWei := new(big.Int).Mul(gp, big.NewInt(evmGasNativeTransfer))
	return f.addL1Fee(ch, []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "std",
		NativeFee: bigToFloat(feeWei),
		GasPrice:  weiToGwei(gp),
	}})
}

// Rollup L1 data-posting cost.
//
// The L2 execution fee ((base + tip) * 21000) is a fraction of a cent on
// every rollup and, on OP Stack chains, a fraction of the L1 data fee the
// wallet actually charges. Publishing execution alone understated
// Optimism, Base and Blast by one to three orders of magnitude (the six
// chains were pulled from the bench on 2026-07-02 for that reason). The
// headline is now execution + L1 data fee, per tier, when the chain
// declares an L1Fee mode; chains whose gas price already embeds the data
// cost (zkSync pubdata, Taiko, Linea) declare none.
//
// The reference payload is a serialized EIP-1559 native transfer (type 2,
// 21000 gas, 20-byte to, 1 ETH value, empty data, r and s filled): about
// 113 bytes, which is what the oracles price. Failures of the L1 call
// are surfaced as an error for the whole sample rather than silently
// publishing the execution-only figure.

// opStackGasPriceOracle and scrollL1GasPriceOracle expose getL1Fee(bytes).
const (
	opStackGasPriceOracle  = "0x420000000000000000000000000000000000000F"
	scrollL1GasPriceOracle = "0x5300000000000000000000000000000000000002"
	getL1FeeSelector       = "49948e0e"
	// Serialized type-2 transfer used as the getL1Fee argument.
	referenceTransferTx = "02f87081a4808459682f008459682f0e825208941111111111111111111111111111111111111111880de0b6b3a764000080c001a01111111111111111111111111111111111111111111111111111111111111111a02222222222222222222222222222222222222222222222222222222222222222"
)

func (f *evmFetcher) addL1Fee(ch ChainConfig, samples []FeeSample) ([]FeeSample, error) {
	switch ch.L1Fee {
	case "":
		return samples, nil
	case "opstack", "scroll":
		oracle := opStackGasPriceOracle
		if ch.L1Fee == "scroll" {
			oracle = scrollL1GasPriceOracle
		}
		l1, err := f.callGetL1Fee(ch.RPCURL, oracle)
		if err != nil {
			return nil, fmt.Errorf("l1 fee (%s): %w", ch.L1Fee, err)
		}
		l1f := bigToFloat(l1)
		for i := range samples {
			samples[i].NativeFee += l1f
		}
		return samples, nil
	case "arbitrum":
		// Nitro reports the L1 component as extra gas on estimateGas
		// (24k to 30k units for a plain transfer versus 21000 of pure
		// execution). Scale each tier by estimated / 21000.
		gas, err := f.callEstimateGasTransfer(ch.RPCURL)
		if err != nil {
			return nil, fmt.Errorf("l1 fee (arbitrum estimateGas): %w", err)
		}
		ratio := float64(gas) / float64(evmGasNativeTransfer)
		if ratio < 1 {
			ratio = 1
		}
		for i := range samples {
			samples[i].NativeFee *= ratio
		}
		return samples, nil
	default:
		return nil, fmt.Errorf("unknown L1Fee mode %q", ch.L1Fee)
	}
}

func (f *evmFetcher) callGetL1Fee(rpcURL, oracle string) (*big.Int, error) {
	// ABI: getL1Fee(bytes) -> offset (0x20), length, data padded to 32.
	txBytes := len(referenceTransferTx) / 2
	pad := (64 - len(referenceTransferTx)%64) % 64
	data := "0x" + getL1FeeSelector +
		fmt.Sprintf("%064x", 0x20) +
		fmt.Sprintf("%064x", txBytes) +
		referenceTransferTx + zeros(pad)
	res, err := f.callHex(rpcURL, "eth_call", []any{map[string]string{"to": oracle, "data": data}, "latest"})
	if err != nil {
		return nil, err
	}
	v, ok := hexToBig(res)
	if !ok {
		return nil, fmt.Errorf("bad getL1Fee result: %s", res)
	}
	return v, nil
}

func (f *evmFetcher) callEstimateGasTransfer(rpcURL string) (int64, error) {
	res, err := f.callHex(rpcURL, "eth_estimateGas", []any{map[string]string{
		"from":  "0x1111111111111111111111111111111111111111",
		"to":    "0x2222222222222222222222222222222222222222",
		"value": "0x1",
	}})
	if err != nil {
		return 0, err
	}
	v, ok := hexToBig(res)
	if !ok {
		return 0, fmt.Errorf("bad estimateGas result: %s", res)
	}
	return v.Int64(), nil
}

// callHex runs a JSON-RPC method that returns a hex string.
func (f *evmFetcher) callHex(rpcURL, method string, params []any) (string, error) {
	body, _ := json.Marshal(jsonRPCReq{JSONRPC: "2.0", Method: method, Params: params, ID: 1})
	resp, err := f.http.Post(rpcURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("http %d", resp.StatusCode)
	}
	var r gasPriceResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", err
	}
	if r.Error != nil {
		return "", fmt.Errorf("rpc error: %s", r.Error.Message)
	}
	return r.Result, nil
}

func zeros(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = '0'
	}
	return string(b)
}

func (f *evmFetcher) sampleFeeHistory(ch ChainConfig) ([]FeeSample, error) {
	body, _ := json.Marshal(jsonRPCReq{
		JSONRPC: "2.0",
		Method:  "eth_feeHistory",
		Params:  []any{"0x4", "latest", []int{25, 50, 90}},
		ID:      1,
	})
	resp, err := f.http.Post(ch.RPCURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, string(raw[:min(len(raw), 200)])) //nolint:gomnd
	}
	var r feeHistoryResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc error: %s", r.Error.Message)
	}
	if len(r.Result.BaseFeePerGas) == 0 {
		return nil, fmt.Errorf("empty baseFeePerGas")
	}
	// Latest base fee = baseFeePerGas[len-1] is the next block's projected base.
	baseFeeHex := r.Result.BaseFeePerGas[len(r.Result.BaseFeePerGas)-1]
	baseFee, ok := hexToBig(baseFeeHex)
	if !ok {
		return nil, fmt.Errorf("bad baseFee hex: %s", baseFeeHex)
	}
	// Average rewards across the 4 returned blocks per percentile so a
	// single empty block doesn't crater an estimate.
	rewards := avgRewards(r.Result.Reward)
	if len(rewards) != 3 {
		return nil, fmt.Errorf("expected 3 reward percentiles, got %d", len(rewards))
	}
	tiers := []string{"slow", "std", "fast"}
	out := make([]FeeSample, 0, 3)
	for i, tier := range tiers {
		gasPriceTotal := new(big.Int).Add(baseFee, rewards[i])
		feeWei := new(big.Int).Mul(gasPriceTotal, big.NewInt(evmGasNativeTransfer))
		out = append(out, FeeSample{
			Chain:     ch.Slug,
			Tier:      tier,
			NativeFee: bigToFloat(feeWei),
			GasPrice:  weiToGwei(gasPriceTotal),
		})
	}
	return out, nil
}

func (f *evmFetcher) callGasPrice(rpcURL string) (*big.Int, error) {
	body, _ := json.Marshal(jsonRPCReq{
		JSONRPC: "2.0",
		Method:  "eth_gasPrice",
		Params:  []any{},
		ID:      1,
	})
	resp, err := f.http.Post(rpcURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d", resp.StatusCode)
	}
	var r gasPriceResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc error: %s", r.Error.Message)
	}
	v, ok := hexToBig(r.Result)
	if !ok {
		return nil, fmt.Errorf("bad gasPrice hex: %s", r.Result)
	}
	return v, nil
}

func hexToBig(h string) (*big.Int, bool) {
	if len(h) >= 2 && (h[:2] == "0x" || h[:2] == "0X") {
		h = h[2:]
	}
	v, ok := new(big.Int).SetString(h, 16)
	return v, ok
}

func bigToFloat(b *big.Int) float64 {
	f, _ := new(big.Float).SetInt(b).Float64()
	return f
}

func weiToGwei(wei *big.Int) float64 {
	gwei := new(big.Float).Quo(new(big.Float).SetInt(wei), big.NewFloat(1e9))
	f, _ := gwei.Float64()
	return f
}

func avgRewards(rows [][]string) []*big.Int {
	if len(rows) == 0 {
		return nil
	}
	cols := len(rows[0])
	sums := make([]*big.Int, cols)
	for i := range sums {
		sums[i] = new(big.Int)
	}
	counted := 0
	for _, row := range rows {
		if len(row) != cols {
			continue
		}
		for i, hex := range row {
			v, ok := hexToBig(hex)
			if !ok {
				continue
			}
			sums[i].Add(sums[i], v)
		}
		counted++
	}
	if counted == 0 {
		return sums
	}
	for i := range sums {
		sums[i].Quo(sums[i], big.NewInt(int64(counted)))
	}
	return sums
}
