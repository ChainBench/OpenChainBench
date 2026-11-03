package main

import (
	"bytes"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// The init code every EVM chain is asked to deploy: the OpenZeppelin
// Contracts Wizard default ERC20 (name, symbol, 18 decimals, whole supply
// minted to the deployer), OpenZeppelin Contracts 5.0.2, solc 0.8.24,
// optimizer 200 runs, evmVersion paris, no metadata hash. Source and the
// compile script sit next to it in contracts/; `node compile.mjs` rebuilds
// these exact bytes (3096 bytes of init code, 1784 bytes of runtime code).
// The same bytes go to every chain, so the gas difference between chains
// is their gas schedule, never a different contract.
//
//go:embed contracts/Token.initcode.hex
var erc20InitHex string

// canonicalERC20Init returns the init code as a 0x-prefixed hex string.
func canonicalERC20Init() string {
	return "0x" + strings.TrimSpace(erc20InitHex)
}

type evmSampler struct {
	http     *http.Client
	opStack  bool
	bytecode string
}

func init() {
	httpClient := &http.Client{Timeout: 10 * time.Second}
	registerSampler(KindEVM, &evmSampler{http: httpClient, bytecode: canonicalERC20Init()})
	registerSampler(KindOPStack, &evmSampler{http: httpClient, opStack: true, bytecode: canonicalERC20Init()})
}

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
	ID      int    `json:"id"`
}

type rpcResp struct {
	JSONRPC string          `json:"jsonrpc"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (s *evmSampler) post(rpcURL string, body any) (json.RawMessage, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest("POST", rpcURL, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var r rpcResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("decode: %w (body=%s)", err, string(raw))
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc error %d: %s", r.Error.Code, r.Error.Message)
	}
	return r.Result, nil
}

func (s *evmSampler) Sample(ch ChainConfig) (Sample, error) {
	// eth_estimateGas for contract creation (to omitted).
	estParams := map[string]string{
		"from": ch.From,
		"data": s.bytecode,
	}
	rawGas, err := s.post(ch.RPCURL, rpcReq{JSONRPC: "2.0", Method: "eth_estimateGas", Params: []any{estParams}, ID: 1})
	if err != nil {
		return Sample{}, fmt.Errorf("eth_estimateGas: %w", err)
	}
	gasHex := ""
	if err := json.Unmarshal(rawGas, &gasHex); err != nil {
		return Sample{}, fmt.Errorf("decode gas: %w", err)
	}
	gas, ok := new(big.Int).SetString(strings.TrimPrefix(gasHex, "0x"), 16)
	if !ok {
		return Sample{}, fmt.Errorf("parse gas hex %q", gasHex)
	}

	// eth_gasPrice for the current network gas price (EIP-1559 chains
	// implement this as base + tip blend; legacy chains return their
	// classic gas price). Good enough for headline cost.
	rawPrice, err := s.post(ch.RPCURL, rpcReq{JSONRPC: "2.0", Method: "eth_gasPrice", Params: []any{}, ID: 2})
	if err != nil {
		return Sample{}, fmt.Errorf("eth_gasPrice: %w", err)
	}
	priceHex := ""
	if err := json.Unmarshal(rawPrice, &priceHex); err != nil {
		return Sample{}, fmt.Errorf("decode price: %w", err)
	}
	gasPrice, ok := new(big.Int).SetString(strings.TrimPrefix(priceHex, "0x"), 16)
	if !ok {
		return Sample{}, fmt.Errorf("parse gasPrice hex %q", priceHex)
	}

	feeWei := evmDeployFeeWei(gas, gasPrice)

	// OP Stack chains: eth_estimateGas only covers L2 execution cost.
	// The actual deployment also pays an L1 data fee, queryable from
	// the predeployed OVM_GasPriceOracle at 0x420...000F via getL1Fee(rlp).
	// For a precise number we'd RLP-encode a deploy tx; for the harness
	// we use the simpler getL1GasUsed(data) + l1BaseFee + scalar formula
	// implicit in getL1Fee(_data). Pass the raw bytecode as approximation
	// — production deploy tx adds nonce/gas overhead but is bounded.
	if s.opStack {
		l1, err := s.opStackL1Fee(ch.RPCURL, s.bytecode)
		if err == nil && l1.Sign() > 0 {
			feeWei = new(big.Int).Add(feeWei, l1)
		}
	}

	costNative, _ := new(big.Float).SetInt(feeWei).Float64()
	gasFloat, _ := new(big.Float).SetInt(gas).Float64()
	return Sample{
		CostNative: costNative,
		NativeUnit: "wei",
		GasUnits:   gasFloat,
	}, nil
}

// evmDeployFeeWei is the execution fee of the deployment: the gas
// eth_estimateGas returns for the init code times the chain's current
// eth_gasPrice (base fee plus the node's suggested tip on EIP-1559 chains).
func evmDeployFeeWei(gas, gasPrice *big.Int) *big.Int {
	return new(big.Int).Mul(gas, gasPrice)
}

// opStackL1Fee calls OVM_GasPriceOracle.getL1Fee(_data) at 0x42..000F
// to get the L1 data-posting cost in wei for a given calldata blob.
// Selector: 0x49948e0e (getL1Fee(bytes)).
func (s *evmSampler) opStackL1Fee(rpcURL, deployData string) (*big.Int, error) {
	data := strings.TrimPrefix(deployData, "0x")
	payload, err := hex.DecodeString(data)
	if err != nil {
		return nil, err
	}
	// ABI-encode (bytes) → offset (0x20) + length + data padded to 32.
	length := len(payload)
	padded := (length + 31) / 32 * 32
	buf := make([]byte, 4+32+32+padded)
	// selector
	buf[0], buf[1], buf[2], buf[3] = 0x49, 0x94, 0x8e, 0x0e
	// offset = 0x20
	buf[35] = 0x20
	// length
	for i, b := range new(big.Int).SetInt64(int64(length)).Bytes() {
		buf[4+32+32-len(new(big.Int).SetInt64(int64(length)).Bytes())+i] = b
	}
	copy(buf[4+32+32:], payload)

	callParams := map[string]string{
		"to":   "0x420000000000000000000000000000000000000F",
		"data": "0x" + hex.EncodeToString(buf),
	}
	rawRes, err := s.post(rpcURL, rpcReq{JSONRPC: "2.0", Method: "eth_call", Params: []any{callParams, "latest"}, ID: 3})
	if err != nil {
		return nil, err
	}
	resHex := ""
	if err := json.Unmarshal(rawRes, &resHex); err != nil {
		return nil, err
	}
	clean := strings.TrimPrefix(resHex, "0x")
	if len(clean) == 0 {
		return nil, fmt.Errorf("empty result")
	}
	v, ok := new(big.Int).SetString(clean, 16)
	if !ok {
		return nil, fmt.Errorf("parse l1Fee hex %q", resHex)
	}
	return v, nil
}

// Silence unused for the NaN sentinel in main.go when gas is unknown.
var _ = math.NaN
