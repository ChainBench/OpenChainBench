package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// userAgent identifies every probe per the OCB methodology page. Providers can
// contact us or block the UA selectively instead of banning a bare Go client.
const userAgent = "OpenChainBench/1.0 (+https://openchainbench.com/methodology; contact@mobula.io)"

type Config struct {
	MoralisAPIKey   string
	AlchemyAPIKey   string
	OpenSeaAPIKey   string
	RaribleAPIKey   string
	MonitorRegion   string
	RefreshInterval int // hours
	Smoke           bool
}

// Package-level globals for the dynamic-collections discovery path.
// Set during loadConfig(), read by activeCollections() in collections.go.
// Kept off Config because activeCollections takes no Config (would
// require threading it through the whole file for a single flag).
//
// COLLECTIONS_MODE:
//   - "" / "static" (default): the COLLECTIONS list in collections.go
//   - "dynamic": top-N ERC721 contracts by unique mint recipients in the
//     last ~10k mints, pulled from Alchemy via alchemy_getAssetTransfers.
//
// DISCOVERY_RPC_URL overrides the default endpoint
// (https://eth-mainnet.g.alchemy.com/v2/<ALCHEMY_API_KEY>). Any JSON-RPC
// endpoint supporting alchemy_getAssetTransfers works.
var (
	cfgCollectionsMode           string
	cfgDiscoveryRPCURL           string
	cfgAlchemyAPIKeyForDiscovery string
)

func loadConfig() *Config {
	cfg := &Config{
		MoralisAPIKey:   strings.TrimSpace(os.Getenv("MORALIS_API_KEY")),
		AlchemyAPIKey:   strings.TrimSpace(os.Getenv("ALCHEMY_API_KEY")),
		OpenSeaAPIKey:   strings.TrimSpace(os.Getenv("OPENSEA_API_KEY")),
		RaribleAPIKey:   strings.TrimSpace(os.Getenv("RARIBLE_API_KEY")),
		MonitorRegion:   strings.TrimSpace(os.Getenv("MONITOR_REGION")),
		RefreshInterval: 6,
	}

	if cfg.MonitorRegion == "" {
		cfg.MonitorRegion = "eu-west"
	}
	if v := strings.TrimSpace(os.Getenv("REFRESH_INTERVAL_HOURS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.RefreshInterval = n
		}
	}

	cfgCollectionsMode = strings.ToLower(strings.TrimSpace(os.Getenv("COLLECTIONS_MODE")))
	cfgDiscoveryRPCURL = strings.TrimSpace(os.Getenv("DISCOVERY_RPC_URL"))
	// Same key drives the NFT REST endpoint and the JSON-RPC endpoint —
	// only the path differs (/nft/v3 vs /v2). Exposed as a package-level
	// global because activeCollections() doesn't see Config.
	cfgAlchemyAPIKeyForDiscovery = cfg.AlchemyAPIKey

	for _, a := range os.Args[1:] {
		if a == "--smoke" {
			cfg.Smoke = true
		}
	}

	return cfg
}

func mask(k string) string {
	if k == "" {
		return "(unset)"
	}
	if len(k) <= 8 {
		return "***"
	}
	return k[:4] + "..." + k[len(k)-4:]
}

func (c *Config) printSummary() {
	mode := cfgCollectionsMode
	if mode == "" {
		mode = "static"
	}
	rpc := cfgDiscoveryRPCURL
	if rpc == "" {
		rpc = "(default: alchemy eth-mainnet)"
	}
	fmt.Println("=== nft-metadata-coverage harness ===")
	fmt.Printf("Region:           %s\n", c.MonitorRegion)
	fmt.Printf("Refresh:          %dh\n", c.RefreshInterval)
	fmt.Printf("Smoke mode:       %v (limits to 10 validated collections when true)\n", c.Smoke)
	fmt.Printf("Collections mode: %s\n", mode)
	if mode == "dynamic" {
		fmt.Printf("Discovery RPC:    %s\n", rpc)
	}
	fmt.Printf("MORALIS_API_KEY:  %s\n", mask(c.MoralisAPIKey))
	fmt.Printf("ALCHEMY_API_KEY:  %s\n", mask(c.AlchemyAPIKey))
	fmt.Printf("OPENSEA_API_KEY:  %s\n", mask(c.OpenSeaAPIKey))
	fmt.Printf("RARIBLE_API_KEY:  %s\n", mask(c.RaribleAPIKey))
	fmt.Println("=====================================")
}
