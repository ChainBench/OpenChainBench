package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// BENJI is Franklin Templeton's OnChain U.S. Government Money Fund
// share, primarily tokenized on Stellar with an Ethereum wrapper.
//
// Ethereum wrapper contract:
//   0x3DDc84940Ab509C11B20B76B466933f40b750dc9
//     (Only 3 holders on Ethereum, ~$47.9M AUM as of 2026-07;
//      the vast majority of BENJI supply lives on Stellar.)
//
// DORMANT — no on-chain NAV path. The Ethereum wrapper does not
// expose sharePrice / NAV via a callable function, and the fund is
// designed to hold NAV = $1.00 stable (yield materializes off-chain
// as fund share credits). Delivered yield is only computable via
// Franklin's own data.
//
// Outreach sent to digitalassets@franklintempleton.com asking for a
// JSON endpoint (or Chainlink feed) exposing daily NAV / 7-day SEC
// yield. Activate this probe once Franklin confirms an endpoint;
// update benjiNAVEndpoint and the fetchJSONNumber path below.

const (
	benjiContractEthereum = "0x3DDc84940Ab509C11B20B76B466933f40b750dc9"
	// Placeholder: Franklin's public JSON endpoint is not yet published.
	// The probe will fail cleanly with nav_source_err until this is
	// updated to the real endpoint (post outreach reply).
	benjiNAVEndpoint = "https://franklintempleton.com/api/funds/29386/nav"
)

type benjiProbe struct {
	contract common.Address
	ring     *navRing
	mu       sync.Mutex
}

func NewBENJIProbe() IssuerProbe {
	return &benjiProbe{
		contract: common.HexToAddress(benjiContractEthereum),
		ring:     newNavRing(72), // ~30 days of daily samples with slack
	}
}

func (p *benjiProbe) Slug() string   { return "benji" }
func (p *benjiProbe) Issuer() string { return "franklin" }
func (p *benjiProbe) Chain() string  { return "ethereum" }

func (p *benjiProbe) Measure(ctx context.Context, rpc *ethclient.Client) (*Measurement, error) {
	now := time.Now().UTC()

	// Fetch current NAV. Franklin publishes daily; the JSON schema is
	// TBD in V1 and will need Sprint 3 verification.
	navNow, err := fetchJSONNumber(benjiNAVEndpoint, []string{"nav", "value"})
	if err != nil {
		return nil, fmt.Errorf("nav source: %w", err)
	}

	// Update the ring with this fresh sample.
	p.mu.Lock()
	p.ring.push(now, navNow)
	nav30d := p.ring.navAt(now.Add(-Window30d))
	nav7d := p.ring.navAt(now.Add(-Window7d))
	p.mu.Unlock()

	// Windowed yield: zero until the ring has coverage for the window.
	// The site distinguishes this from a genuine zero via the
	// probe_ok / sample_size labels.
	yield30dBps := 0
	if nav30d > 0 {
		yield30dBps = annualizedYieldBpsFromNAV(navNow, nav30d, 30.0)
	}
	yield7dBps := 0
	if nav7d > 0 {
		yield7dBps = annualizedYieldBpsFromNAV(navNow, nav7d, 7.0)
	}

	// Optional: read totalSupply from the Ethereum wrapper if the
	// contract address is set. Skipped when address is zero (V1 default).
	var supplyUnits float64
	if p.contract != (common.Address{}) {
		if s, err := readERC20TotalSupply(ctx, rpc, p.contract, nil); err == nil {
			supplyUnits = s / 1e18
		}
	}
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
		NewDistributionsUSD:  0, // NAV model, no dividend transfers
		MeasuredAt:           now,
	}, nil
}

// annualizedYieldBpsFromNAV computes yield from NAV growth over a
// windowDays period, annualized, expressed in basis points.
func annualizedYieldBpsFromNAV(navEnd, navStart, windowDays float64) int {
	if navStart <= 0 {
		return 0
	}
	growth := (navEnd - navStart) / navStart
	annualized := growth * (365.0 / windowDays)
	return int(annualized * 10000)
}
