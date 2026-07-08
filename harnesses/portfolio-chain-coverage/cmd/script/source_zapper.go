package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// Zapper public GraphQL. Auth is the raw key in the x-zapper-api-key
// header.
//
// Zapper exposes NO standalone machine-readable chain-catalog
// endpoint, so listed and verified both come from the single
// portfolioV2 probe (1 call per cycle):
//
//	listed   = distinct networks visible in tokenBalances.byNetwork
//	           (exported with listed_source="probe" so dashboards can
//	           distinguish it from a declared catalog)
//	verified = those networks with balanceUSD > $1
//
// Field casing verified against build.zapper.xyz/docs/api/endpoints/
// portfolio on 2026-07-03: portfolioV2 → tokenBalances →
// byNetwork(first:) → edges → node { network { name slug chainId }
// balanceUSD }.
const zapperBaseDefault = "https://public.zapper.xyz/graphql"

const zapperQuery = `query PortfolioNetworks($addresses: [Address!]!) {
  portfolioV2(addresses: $addresses) {
    tokenBalances {
      byNetwork(first: 200) {
        edges {
          node {
            network { name slug chainId }
            balanceUSD
          }
        }
      }
    }
  }
}`

func probeZapper(key string) coverage {
	base := envDefault("ZAPPER_BASE_URL", zapperBaseDefault)
	hdr := map[string]string{
		"x-zapper-api-key": key,
		"Content-Type":     "application/json",
	}
	cov := coverage{listed: -1, listedSource: "probe", verified: -1, probed: -1}

	body, err := json.Marshal(map[string]any{
		"query":     zapperQuery,
		"variables": map[string]any{"addresses": []string{evmTestAddress}},
	})
	if err != nil {
		recordError("zapper", err)
		return cov
	}

	var total time.Duration
	raw, el, err := doCall("zapper", "POST", base, hdr, body)
	total += el
	if err != nil {
		recordError("zapper", err)
		fmt.Printf("[zapper] portfolioV2 probe failed: %v\n", err)
	} else if listed, verified, perr := parseZapperPortfolio(raw); perr != nil {
		recordError("zapper", perr)
		fmt.Printf("[zapper] portfolioV2 parse failed: %v\n", perr)
	} else {
		cov.listed = listed
		cov.verified = verified
	}

	// Single-call probe: per-network funding cannot be established,
	// so probed reports the conservative floor.
	cov.probed = cov.verified
	cov.latencyMs = float64(total.Milliseconds())
	return cov
}

// parseZapperPortfolio returns (probe-visible network count, networks
// with balanceUSD > $1). GraphQL transports schema errors inside a
// 200 body, so the errors array is checked before data.
func parseZapperPortfolio(raw []byte) (int, int, error) {
	var resp struct {
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
		Data struct {
			PortfolioV2 struct {
				TokenBalances struct {
					ByNetwork struct {
						Edges []struct {
							Node struct {
								Network struct {
									Name    string      `json:"name"`
									Slug    string      `json:"slug"`
									ChainID json.Number `json:"chainId"`
								} `json:"network"`
								BalanceUSD float64 `json:"balanceUSD"`
							} `json:"node"`
						} `json:"edges"`
					} `json:"byNetwork"`
				} `json:"tokenBalances"`
			} `json:"portfolioV2"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return 0, 0, fmt.Errorf("parse portfolioV2: %w", err)
	}
	if len(resp.Errors) > 0 {
		return 0, 0, fmt.Errorf("graphql error: %s", resp.Errors[0].Message)
	}

	seen := map[string]bool{}
	verified := 0
	for _, e := range resp.Data.PortfolioV2.TokenBalances.ByNetwork.Edges {
		id := e.Node.Network.Slug
		if id == "" {
			id = e.Node.Network.Name
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if e.Node.BalanceUSD > verifiedUsdThreshold {
			verified++
		}
	}
	return len(seen), verified, nil
}
