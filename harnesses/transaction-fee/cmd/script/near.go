package main

import (
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// NEAR native-transfer fee sampler.
//
// A NEAR transaction burns gas at the block's gas price (yoctoNEAR per
// gas). A one-action Transfer between two existing named accounts burns
// the receipt-creation and transfer costs twice, once when the signer
// converts the transaction into a receipt (send_not_sir) and once when
// the receiver executes it (execution):
//
//   gas = action_receipt_creation.send_not_sir + action_receipt_creation.execution
//       + transfer_cost.send_not_sir           + transfer_cost.execution
//   fee_yocto = gas * gas_price
//
// Protocol 86: 2 * (108_059_500_000 + 115_123_062_500) = 446_365_125_000
// gas, which at 1e8 yocto per gas is 0.0000446 NEAR. Checked 2026-11-03
// against mainnet: every named-to-named Transfer on nearblocks burnt
// exactly 44_636_512_500_000_000_000 yocto. A transfer to an implicit
// (64 hex) account that does not exist yet also creates the account and
// costs about 19x more; that is account creation, not a transfer, and is
// out of scope like on every other chain here.
//
// Both inputs come from the RPC: `gas_price` (latest block) every tick,
// and `EXPERIMENTAL_protocol_config` (the runtime fee table) once an
// hour, so a protocol upgrade that reprices actions shows up without a
// code change.
// One tier: NEAR has no priority fee.

const nearConfigTTL = time.Hour

type nearFetcher struct {
	http *http.Client

	mu        sync.Mutex
	cachedGas float64
	cachedAt  time.Time
}

func init() {
	registerFetcher(KindNear, &nearFetcher{http: &http.Client{Timeout: 10 * time.Second}})
}

type nearFee struct {
	Execution  int64 `json:"execution"`
	SendNotSir int64 `json:"send_not_sir"`
}

type nearProtocolConfigResp struct {
	Result *struct {
		RuntimeConfig struct {
			TransactionCosts struct {
				ActionReceiptCreationConfig nearFee `json:"action_receipt_creation_config"`
				ActionCreationConfig        struct {
					TransferCost nearFee `json:"transfer_cost"`
				} `json:"action_creation_config"`
			} `json:"transaction_costs"`
		} `json:"runtime_config"`
	} `json:"result"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type nearGasPriceResp struct {
	Result *struct {
		GasPrice string `json:"gas_price"`
	} `json:"result"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// transferGas returns the transfer gas from the runtime fee table. The
// table only changes with a protocol upgrade, and the public NEAR RPC
// endpoints answer 429 when it is fetched every 30 s next to gas_price,
// so it is cached for nearConfigTTL; on a failed refresh the last good
// value is kept and the error only surfaces when there is none.
func (f *nearFetcher) transferGas(rpcURL string) (float64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cachedGas > 0 && time.Since(f.cachedAt) < nearConfigTTL {
		return f.cachedGas, nil
	}
	gas, err := f.fetchTransferGas(rpcURL)
	if err != nil {
		if f.cachedGas > 0 {
			fmt.Printf("[near] protocol_config refresh failed, keeping cached gas: %v\n", err)
			return f.cachedGas, nil
		}
		return 0, err
	}
	f.cachedGas, f.cachedAt = gas, time.Now()
	return gas, nil
}

func (f *nearFetcher) fetchTransferGas(rpcURL string) (float64, error) {
	var pc nearProtocolConfigResp
	if err := postJSON(f.http, rpcURL, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "EXPERIMENTAL_protocol_config",
		"params": map[string]string{"finality": "final"},
	}, &pc); err != nil {
		return 0, fmt.Errorf("near protocol_config: %w", err)
	}
	if pc.Error != nil {
		return 0, fmt.Errorf("near protocol_config rpc error: %s", pc.Error.Message)
	}
	if pc.Result == nil {
		return 0, fmt.Errorf("near protocol_config: empty result")
	}
	tc := pc.Result.RuntimeConfig.TransactionCosts
	gas := nearTransferGas(tc.ActionReceiptCreationConfig, tc.ActionCreationConfig.TransferCost)
	if gas <= 0 {
		return 0, fmt.Errorf("near protocol_config: transfer costs missing")
	}
	return gas, nil
}

// nearTransferGas is the gas a named-to-named one-action Transfer burns.
func nearTransferGas(receipt, transfer nearFee) float64 {
	return float64(receipt.SendNotSir + receipt.Execution + transfer.SendNotSir + transfer.Execution)
}

func (f *nearFetcher) Sample(ch ChainConfig) ([]FeeSample, error) {
	var gp nearGasPriceResp
	if err := postJSON(f.http, ch.RPCURL, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "gas_price", "params": []any{nil},
	}, &gp); err != nil {
		return nil, fmt.Errorf("near gas_price: %w", err)
	}
	if gp.Error != nil {
		return nil, fmt.Errorf("near gas_price rpc error: %s", gp.Error.Message)
	}
	if gp.Result == nil {
		return nil, fmt.Errorf("near gas_price: empty result")
	}
	price, err := strconv.ParseFloat(gp.Result.GasPrice, 64)
	if err != nil || price <= 0 {
		return nil, fmt.Errorf("near gas_price: bad value %q", gp.Result.GasPrice)
	}

	gas, err := f.transferGas(ch.RPCURL)
	if err != nil {
		return nil, err
	}
	return []FeeSample{{
		Chain:     ch.Slug,
		Tier:      "single",
		NativeFee: gas * price,
	}}, nil
}
