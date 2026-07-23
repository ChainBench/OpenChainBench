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
// share tokenized primarily on Stellar, with an Ethereum wrapper. NAV
// appreciation model: share price grows daily as yield accrues; there
// are no on-chain dividend transfers to holders.
//
// Ethereum wrapper contract (BENJI):
//   0x... (TODO Sprint 3: confirm Ethereum wrapper address; primary
//         chain is Stellar)
//
// NAV source: Franklin Templeton's fund page publishes 7-day SEC yield
// and current NAV. V1 uses the current NAV endpoint and stores daily
// snapshots in memory for windowed yield computation (see nav.go).
//
// V1 caveats:
//   - Ethereum wrapper may not be widely traded; the "true" BENJI
//     supply lives on Stellar. Ethereum totalSupply is a lower bound.
//   - Franklin's official endpoint URL is TBD (V1 uses a placeholder;
//     Sprint 3 verifies via Franklin's own dashboard).
//   - The 30d yield only becomes reliable after 30 days of harness
//     uptime, since we bootstrap NAV history from scratch.

const (
	benjiContractEthereum = "0x0000000000000000000000000000000000000000" // TODO Sprint 3
	// Franklin publishes the fund's current 7-day SEC yield on its
	// public fund page. Actual JSON endpoint TBD Sprint 3; placeholder
	// URL fails cleanly and the probe reports nav_source_err.
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
