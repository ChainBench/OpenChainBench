package main

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// SyrupUSDC is Maple Finance's yield-bearing USDC token — an ERC-4626
// vault whose underlying position is a book of over-collateralized
// (and, more recently, undercollateralized) institutional USDC loans.
// Share price grows daily as pool interest accrues; no rebase, no
// dividend transfers.
//
// Contract (Ethereum mainnet):
//   0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b  (6 decimals, asset=USDC)
//
// Yield model: NAV appreciation via ERC-4626 convertToAssets().
// Passing 1e6 (one share in 6 decimals) returns the current USDC value
// of one share directly. Called at a historical block, we get the NAV
// that was current at that block — same clean methodology as OUSG and
// USTB, no off-chain data needed.
//
// Scope note: SyrupUSDC is NOT a T-bill wrapper — it's collateralized
// pool lending, so deviation from advertised APY reflects both loan-
// book performance AND yield disclosure honesty. Included in bench 089
// under the broader framing "on-chain yield-bearing stables promising
// an APY," not the narrow "tokenized T-bill" reading.
//
// Advertised APY tracked here is the pool's BASE APY (yield generated
// by the loan book), not the boosted APY including SYRUP token
// incentives. This matches what we can measure on-chain: convertToAssets
// only reflects underlying pool yield, not off-chain reward
// distributions.

const (
	syrupUSDCContractEthereum = "0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b"
	// One share in the token's 6-decimal base units. Passing this to
	// convertToAssets returns USDC-per-share directly.
	syrupUSDCOneShareRaw = uint64(1_000_000)
)

var erc4626ConvertToAssetsSelector []byte

func init() {
	erc4626ConvertToAssetsSelector = crypto.Keccak256([]byte("convertToAssets(uint256)"))[:4]
}

type syrupUSDCProbe struct {
	contract common.Address
}

func NewSyrupUSDCProbe() IssuerProbe {
	return &syrupUSDCProbe{
		contract: common.HexToAddress(syrupUSDCContractEthereum),
	}
}

func (p *syrupUSDCProbe) Slug() string   { return "syrup-usdc" }
func (p *syrupUSDCProbe) Issuer() string { return "maple" }
func (p *syrupUSDCProbe) Chain() string  { return "ethereum" }

func (p *syrupUSDCProbe) Measure(ctx context.Context, rpc *ethclient.Client) (*Measurement, error) {
	now := time.Now().UTC()

	latest, err := rpc.BlockNumber(ctx)
	if err != nil {
		return nil, fmt.Errorf("latest block: %w", err)
	}
	block30dAgo := blockOffsetBySeconds(latest, int64(Window30d.Seconds()))
	block7dAgo := blockOffsetBySeconds(latest, int64(Window7d.Seconds()))

	// USDC-per-share at each snapshot. 6-decimal in, 6-decimal out; the
	// returned float64 is already scaled to USD.
	navNow, err := p.readSharePriceUSD(ctx, rpc, nil)
	if err != nil {
		return nil, fmt.Errorf("nav now: %w", err)
	}
	nav30d, err := p.readSharePriceUSD(ctx, rpc, block30dAgo)
	if err != nil {
		return nil, fmt.Errorf("nav 30d: %w", err)
	}
	nav7d, err := p.readSharePriceUSD(ctx, rpc, block7dAgo)
	if err != nil {
		return nil, fmt.Errorf("nav 7d: %w", err)
	}

	yield30dBps := annualizedYieldBpsFromNAV(navNow, nav30d, 30.0)
	yield7dBps := annualizedYieldBpsFromNAV(navNow, nav7d, 7.0)

	supply, err := readERC20TotalSupply(ctx, rpc, p.contract, nil)
	if err != nil {
		supply = 0
	}
	supplyUnits := supply / 1e6

	return &Measurement{
		Token:                p.Slug(),
		Issuer:               p.Issuer(),
		Chain:                p.Chain(),
		DeliveredBps30d:      yield30dBps,
		DeliveredBps7d:       yield7dBps,
		DeliveredBpsLifetime: 0,
		TotalSupplyUnits:     supplyUnits,
		AUMUSD:               supplyUnits * navNow,
		NewDistributionsUSD:  0,
		MeasuredAt:           now,
	}, nil
}

// readSharePriceUSD returns USDC-per-share as a float. Calls
// convertToAssets(1 share) which for a 6-decimal vault yields a
// 6-decimal USDC amount that we scale to USD (divide by 1e6).
func (p *syrupUSDCProbe) readSharePriceUSD(ctx context.Context, rpc *ethclient.Client, blockNumber *big.Int) (float64, error) {
	// ABI-encoded call: selector + uint256(1_000_000) left-padded.
	amount := new(big.Int).SetUint64(syrupUSDCOneShareRaw)
	data := make([]byte, 0, 4+32)
	data = append(data, erc4626ConvertToAssetsSelector...)
	data = append(data, common.LeftPadBytes(amount.Bytes(), 32)...)

	msg := ethereum.CallMsg{To: &p.contract, Data: data}
	result, err := rpc.CallContract(ctx, msg, blockNumber)
	if err != nil {
		return 0, err
	}
	if len(result) < 32 {
		return 0, fmt.Errorf("convertToAssets: short response")
	}
	assets := new(big.Int).SetBytes(result[0:32])
	f, _ := new(big.Float).SetInt(assets).Float64()
	return f / 1e6, nil
}
