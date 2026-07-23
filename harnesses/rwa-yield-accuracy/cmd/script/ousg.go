package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// OUSG is Ondo's Short-Term U.S. Government Treasuries token. NAV
// appreciation model: share price grows daily; no dividend transfers.
//
// Ethereum contract (OUSG):
//   0x1B19C19393e2d034D8Ff31fF34c81252FcBbee92
//
// NAV source: Ondo publishes daily NAV on the OUSG dashboard. V1 uses
// the public endpoint (TBD schema, verified Sprint 3) plus in-memory
// NAV history for windowed yield.
//
// Ondo also runs a Chainlink Proof-of-Reserves feed for OUSG that
// could serve as an on-chain NAV source. V2 will switch to that feed
// where available to remove the offchain HTTP dependency.

const (
	ousgContractEthereum = "0x1B19C19393e2d034D8Ff31fF34c81252FcBbee92"
	// Ondo publishes NAV on its API. Actual endpoint TBD Sprint 3.
	ousgNAVEndpoint = "https://api.ondo.finance/v1/products/ousg/nav"
)

type ousgProbe struct {
	contract common.Address
	ring     *navRing
	mu       sync.Mutex
}

func NewOUSGProbe() IssuerProbe {
	return &ousgProbe{
		contract: common.HexToAddress(ousgContractEthereum),
		ring:     newNavRing(72),
	}
}

func (p *ousgProbe) Slug() string   { return "ousg" }
func (p *ousgProbe) Issuer() string { return "ondo" }
func (p *ousgProbe) Chain() string  { return "ethereum" }

func (p *ousgProbe) Measure(ctx context.Context, rpc *ethclient.Client) (*Measurement, error) {
	now := time.Now().UTC()

	navNow, err := fetchJSONNumber(ousgNAVEndpoint, []string{"nav"})
	if err != nil {
		return nil, fmt.Errorf("nav source: %w", err)
	}

	p.mu.Lock()
	p.ring.push(now, navNow)
	nav30d := p.ring.navAt(now.Add(-Window30d))
	nav7d := p.ring.navAt(now.Add(-Window7d))
	p.mu.Unlock()

	yield30dBps := 0
	if nav30d > 0 {
		yield30dBps = annualizedYieldBpsFromNAV(navNow, nav30d, 30.0)
	}
	yield7dBps := 0
	if nav7d > 0 {
		yield7dBps = annualizedYieldBpsFromNAV(navNow, nav7d, 7.0)
	}

	supply, err := readERC20TotalSupply(ctx, rpc, p.contract, nil)
	if err != nil {
		// Non-fatal: NAV yield can still be reported without supply.
		supply = 0
	}
	supplyUnits := supply / 1e18
	aum := supplyUnits * navNow

	return &Measurement{
		Token:                p.Slug(),
		Issuer:               p.Issuer(),
		Chain:                p.Chain(),
		DeliveredBps30d:      yield30dBps,
		DeliveredBps7d:       yield7dBps,
		DeliveredBpsLifetime: 0, // V1 placeholder
		TotalSupplyUnits:     supplyUnits,
		AUMUSD:               aum,
		NewDistributionsUSD:  0,
		MeasuredAt:           now,
	}, nil
}
