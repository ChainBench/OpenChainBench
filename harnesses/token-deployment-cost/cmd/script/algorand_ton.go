package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"
)

type algorandSampler struct {
	http *http.Client
}

type tonSampler struct {
	http *http.Client
}

func init() {
	registerSampler(KindAlgorand, &algorandSampler{http: &http.Client{Timeout: 8 * time.Second}})
	registerSampler(KindTON, &tonSampler{http: &http.Client{Timeout: 10 * time.Second}})
}

func getJSON(c *http.Client, url string, out any) error {
	resp, err := c.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http %d: %.200s", resp.StatusCode, string(raw))
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode: %w (body=%.200s)", err, string(raw))
	}
	return nil
}

// ----- Algorand ----------------------------------------------------------

// An Algorand Standard Asset is created by one asset config transaction
// (acfg). The creator pays:
//
//   - the transaction fee, max(min-fee, fee-per-byte x tx size), both read
//     live from algod /v2/transactions/params. fee-per-byte is 0 outside
//     congestion, so this is the 1000 microAlgo min fee in practice;
//   - a 0.1 ALGO raise of its own minimum balance for the asset it now
//     holds (consensus parameter MinBalance per asset, not exposed by any
//     endpoint, hence pinned). That 0.1 ALGO stays the creator's but is
//     locked until the asset is destroyed, which needs the whole supply
//     back in the creator's account. It is counted for the same reason
//     Stellar's reserves and Solana's rent are: the asset cannot exist
//     without it.
const (
	algorandAssetMinBalanceMicroAlgo = 100_000
	// An acfg carrying a name, a unit name, a URL and the four role
	// addresses serialises to about 250 bytes; only matters when the
	// network is congested and fee-per-byte goes above zero.
	algorandAcfgTxBytes = 250
)

type algodParams struct {
	Fee    *uint64 `json:"fee"`
	MinFee *uint64 `json:"min-fee"`
}

// algorandASACost returns the total in microAlgos: tx fee + per-asset
// minimum balance.
func algorandASACost(minFee, feePerByte uint64) uint64 {
	fee := feePerByte * algorandAcfgTxBytes
	if fee < minFee {
		fee = minFee
	}
	return fee + algorandAssetMinBalanceMicroAlgo
}

func (s *algorandSampler) Sample(ch ChainConfig) (Sample, error) {
	var p algodParams
	if err := getJSON(s.http, ch.RPCURL+"/v2/transactions/params", &p); err != nil {
		return Sample{}, err
	}
	if p.MinFee == nil || *p.MinFee == 0 || p.Fee == nil {
		return Sample{}, fmt.Errorf("algod params without min-fee/fee")
	}
	micro := algorandASACost(*p.MinFee, *p.Fee)
	return Sample{CostNative: float64(micro), NativeUnit: "microalgo", GasUnits: math.NaN()}, nil
}

// ----- Gram (TON) --------------------------------------------------------

// A jetton is brought into existence by the canonical minter.ton.org flow:
// the owner's wallet sends an external message, which carries the jetton
// minter's StateInit to the minter address together with a mint; the
// minter deploys the owner's jetton wallet with the first supply, and the
// jetton wallet sends a transfer notification and the unspent value back
// to the owner.
//
// No public endpoint estimates that chain of five transactions without a
// signed message, so the harness pins the resources the flow consumes and
// prices them with the live basechain config: param 21 (gas prices) and
// param 25 (message forward prices), read from tonapi /v2/blockchain/config.
//
// The resources come from a real mainnet deploy of the standard minter
// (code hash mg+Y3W+/Il7vgWXk5kQX7pMffuoABlNDnntdzcBkTNY=, the
// ton-blockchain/minter jetton-minter), trace
// acce6cf1a6e7b90faf86d23a4066d773652cb3ffbae2e9c55de9c4e094bbb382 of
// 2026-05-08: compute gas per transaction as recorded, message sizes
// solved from the recorded forward fees (bits + 100 x cells). Priced with
// the config in force that day (the same values as on 2026-11-03), the
// model returns 5,001,810 nanoton against the 5,001,838 the trace burned
// (sum of its total_fees and imported forward fees): 28 nanoton apart, in
// the external message's import fee rounding. The test pins this. TON fees are what is burned; the 0.25 TON the minter UI
// attaches is not a fee, it ends as the minter's and the jetton wallet's
// balances or comes back to the owner as excess.
var tonJettonGas = []uint64{4939, 6656, 10024, 778, 778} // wallet ext, minter, jetton wallet, notify, excess

type tonMsg struct{ bits, cells uint64 }

var (
	// The external message into the owner's wallet (charged as an import fee).
	tonJettonExtMsg = tonMsg{bits: 14409, cells: 47}
	// Internal messages, each charged a full forward fee.
	tonJettonIntMsgs = []tonMsg{
		{bits: 13902, cells: 46}, // wallet -> minter, minter StateInit + mint
		{bits: 6974, cells: 20},  // minter -> jetton wallet, wallet StateInit + internal_transfer
		{bits: 167, cells: 0},    // jetton wallet -> owner, transfer_notification
		{bits: 100, cells: 0},    // jetton wallet -> owner, excesses
	}
)

type tonGasPrices struct {
	FlatGasLimit uint64 `json:"flat_gas_limit"`
	FlatGasPrice uint64 `json:"flat_gas_price"`
	GasPrice     uint64 `json:"gas_price"` // nanoton per 2^16 gas
}

type tonMsgPrices struct {
	LumpPrice uint64 `json:"lump_price"`
	BitPrice  uint64 `json:"bit_price"`  // nanoton per 2^16 bits
	CellPrice uint64 `json:"cell_price"` // nanoton per 2^16 cells
}

type tonConfig struct {
	P21 struct {
		GasLimitsPrices tonGasPrices `json:"gas_limits_prices"`
	} `json:"21"`
	P25 struct {
		MsgForwardPrices tonMsgPrices `json:"msg_forward_prices"`
	} `json:"25"`
}

func ceilDiv16(x uint64) uint64 { return (x + 65535) >> 16 }

// tonGasFee: the TVM gas fee of one transaction (flat part + the rest at
// gas_price / 2^16).
func tonGasFee(g tonGasPrices, gas uint64) uint64 {
	if gas <= g.FlatGasLimit {
		return g.FlatGasPrice
	}
	return g.FlatGasPrice + ceilDiv16((gas-g.FlatGasLimit)*g.GasPrice)
}

// tonFwdFee: lump_price + ceil((bit_price x bits + cell_price x cells) / 2^16).
func tonFwdFee(p tonMsgPrices, m tonMsg) uint64 {
	return p.LumpPrice + ceilDiv16(p.BitPrice*m.bits+p.CellPrice*m.cells)
}

// tonJettonDeployNanoton prices the pinned flow with one basechain config.
func tonJettonDeployNanoton(g tonGasPrices, p tonMsgPrices) (total uint64, gas uint64) {
	for _, u := range tonJettonGas {
		total += tonGasFee(g, u)
		gas += u
	}
	total += tonFwdFee(p, tonJettonExtMsg)
	for _, m := range tonJettonIntMsgs {
		total += tonFwdFee(p, m)
	}
	return total, gas
}

func (s *tonSampler) Sample(ch ChainConfig) (Sample, error) {
	var c tonConfig
	if err := getJSON(s.http, ch.RPCURL+"/v2/blockchain/config", &c); err != nil {
		return Sample{}, err
	}
	g, p := c.P21.GasLimitsPrices, c.P25.MsgForwardPrices
	if g.GasPrice == 0 || p.BitPrice == 0 || p.CellPrice == 0 {
		return Sample{}, fmt.Errorf("config params 21/25 missing from tonapi answer")
	}
	nano, gas := tonJettonDeployNanoton(g, p)
	return Sample{CostNative: float64(nano), NativeUnit: "ton-nano", GasUnits: float64(gas)}, nil
}
