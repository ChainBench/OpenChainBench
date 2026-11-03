package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type nearSampler struct {
	http *http.Client
}

type icpSampler struct {
	http *http.Client
	now  func() time.Time
}

func init() {
	registerSampler(KindNear, &nearSampler{http: &http.Client{Timeout: 10 * time.Second}})
	registerSampler(KindICP, &icpSampler{http: &http.Client{Timeout: 10 * time.Second}, now: time.Now})
}

// ----- NEAR --------------------------------------------------------------

// A NEP-141 token on NEAR is a contract on its own account, and NEAR
// charges storage staking for every byte an account holds (code + state)
// at runtime_config.storage_amount_per_byte, 1e19 yoctoNEAR (1 NEAR per
// 100 kB). The canonical no-code path is the tkn.near token factory (Ref
// Finance's, 756 tokens on 2026-11-03), which creates <symbol>.tkn.near,
// deploys a 213,058 byte FT contract and initialises its metadata.
//
// Cost = the factory's own quote + the transaction fee:
//   - tkn.near get_required_deposit(args, account_id), a view call, returns
//     the deposit create_token asserts, i.e. the storage stake of the new
//     token account priced at the live storage price. It is locked in the
//     token account for as long as the token exists, not a fee, and counted
//     for the same reason as Solana rent and Stellar reserves.
//   - the gas the create_token transaction burns. Three create_token
//     transactions of October 2026 burned 1.0511e22, 1.0582e22 and
//     1.0917e22 yoctoNEAR at the 1e8 yocto/gas floor price, i.e. about
//     106 Tgas; the harness pins 106 Tgas and prices it at the live
//     gas_price.
const nearCreateTokenGas = 106e12

// The token the quote is asked for: the same name and symbol as the EVM
// leg's ERC20, 18 decimals, no icon (an inline data-URI icon would add its
// bytes to the stake).
var nearQuoteArgs = map[string]any{
	"args": map[string]any{
		"owner_id":     "openchainbench.near",
		"total_supply": "1000000000000000000000000000",
		"metadata": map[string]any{
			"spec": "ft-1.0.0", "name": "OpenChainBench Token", "symbol": "OCBT", "decimals": 18,
			"icon": nil, "reference": nil, "reference_hash": nil,
		},
	},
	"account_id": "openchainbench.near",
}

const nearFactoryAccount = "tkn.near"

type nearRPCResp struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	} `json:"error"`
}

func (s *nearSampler) rpc(url, method string, params any) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	resp, err := s.http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var r nearRPCResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("decode: %w (body=%.200s)", err, string(raw))
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc error: %s %.200s", r.Error.Message, string(r.Error.Data))
	}
	return r.Result, nil
}

// parseNearRequiredDeposit decodes a call_function result whose bytes are
// the JSON string of a U128 ("2233430000000000000000000").
func parseNearRequiredDeposit(result json.RawMessage) (*big.Int, error) {
	// call_function returns the bytes as a JSON array of numbers, and a
	// contract panic as an "error" string next to an empty result.
	var arr struct {
		Result []int  `json:"result"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal(result, &arr); err != nil {
		return nil, fmt.Errorf("decode call_function: %w", err)
	}
	if arr.Error != "" {
		return nil, fmt.Errorf("view call failed: %.200s", arr.Error)
	}
	buf := make([]byte, len(arr.Result))
	for i, b := range arr.Result {
		buf[i] = byte(b)
	}
	var s string
	if err := json.Unmarshal(buf, &s); err != nil {
		return nil, fmt.Errorf("decode deposit %q: %w", string(buf), err)
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.Sign() <= 0 {
		return nil, fmt.Errorf("bad deposit %q", s)
	}
	return v, nil
}

// nearTokenCostYocto = factory deposit + pinned create_token gas x gas price.
func nearTokenCostYocto(deposit *big.Int, gasPriceYocto uint64) *big.Int {
	gas := new(big.Int).Mul(big.NewInt(int64(nearCreateTokenGas)), new(big.Int).SetUint64(gasPriceYocto))
	return new(big.Int).Add(deposit, gas)
}

// Sample tries each comma-separated endpoint in RPCURL in turn.
func (s *nearSampler) Sample(ch ChainConfig) (Sample, error) {
	var errs []string
	for _, u := range strings.Split(ch.RPCURL, ",") {
		if u = strings.TrimSpace(u); u == "" {
			continue
		}
		out, err := s.sampleOne(u)
		if err == nil {
			return out, nil
		}
		errs = append(errs, u+": "+err.Error())
	}
	return Sample{}, fmt.Errorf("%s", strings.Join(errs, "; "))
}

func (s *nearSampler) sampleOne(url string) (Sample, error) {
	args, _ := json.Marshal(nearQuoteArgs)
	res, err := s.rpc(url, "query", map[string]any{
		"request_type": "call_function", "finality": "final",
		"account_id": nearFactoryAccount, "method_name": "get_required_deposit",
		"args_base64": base64.StdEncoding.EncodeToString(args),
	})
	if err != nil {
		return Sample{}, fmt.Errorf("get_required_deposit: %w", err)
	}
	deposit, err := parseNearRequiredDeposit(res)
	if err != nil {
		return Sample{}, err
	}
	gpRaw, err := s.rpc(url, "gas_price", []any{nil})
	if err != nil {
		return Sample{}, fmt.Errorf("gas_price: %w", err)
	}
	var gp struct {
		GasPrice string `json:"gas_price"`
	}
	if err := json.Unmarshal(gpRaw, &gp); err != nil {
		return Sample{}, fmt.Errorf("decode gas_price: %w", err)
	}
	price, err := strconv.ParseUint(gp.GasPrice, 10, 64)
	if err != nil || price == 0 {
		return Sample{}, fmt.Errorf("bad gas_price %q", gp.GasPrice)
	}
	total := nearTokenCostYocto(deposit, price)
	f, _ := new(big.Float).SetInt(total).Float64()
	return Sample{CostNative: f, NativeUnit: "yocto", GasUnits: nearCreateTokenGas}, nil
}

// ----- Internet Computer -------------------------------------------------

// An ICRC-1 token on the Internet Computer is a ledger canister. Creating
// a canister on a 13-node application subnet costs a protocol fee of 500
// billion cycles (500B; the fee scales with subnet size, 13 nodes is the
// default subnet). Cycles are pegged to the IMF SDR: 1 trillion cycles =
// 1 XDR, and ICP converts to cycles at the cycles minting canister's live
// ICP/XDR rate, published by ic-api /api/v3/icp-xdr-conversion-rates as
// XDR permyriad per ICP.
//
// Priced: the 500B creation fee only, the floor nobody avoids. Not priced:
// the install message of the ledger Wasm and the cycles balance the ledger
// must keep above its freezing threshold to run (that balance is not
// consumed at creation). The page says so.
const icpCanisterCreationCycles = 500e9

// icpCyclesToE8s: 1 ICP = permyriad x 1e8 cycles, so e8s = cycles / permyriad.
func icpCyclesToE8s(cycles float64, xdrPermyriadPerICP float64) float64 {
	return cycles / xdrPermyriadPerICP
}

func (s *icpSampler) Sample(ch ChainConfig) (Sample, error) {
	var r struct {
		Rates [][2]float64 `json:"icp_xdr_conversion_rates"`
	}
	if err := getJSON(s.http, ch.RPCURL+"/api/v3/icp-xdr-conversion-rates?limit=1", &r); err != nil {
		return Sample{}, err
	}
	if len(r.Rates) == 0 || r.Rates[0][1] <= 0 {
		return Sample{}, fmt.Errorf("no ICP/XDR rate")
	}
	ts, permyriad := r.Rates[0][0], r.Rates[0][1]
	if age := s.now().Sub(time.Unix(int64(ts), 0)); age > 24*time.Hour {
		return Sample{}, fmt.Errorf("ICP/XDR rate is %s old", age.Round(time.Minute))
	}
	e8s := icpCyclesToE8s(icpCanisterCreationCycles, permyriad)
	return Sample{CostNative: e8s, NativeUnit: "e8s", GasUnits: icpCanisterCreationCycles}, nil
}
