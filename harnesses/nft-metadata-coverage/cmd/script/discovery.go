package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Default discovery RPC. Uses Alchemy's purpose-built
// alchemy_getAssetTransfers endpoint (works on free tier), which:
//   - returns ERC721 mint transfers in a single call (no eth_getLogs chunking)
//   - rich payload with rawContract.address, to, blockNum already decoded
//   - bypasses the eth_getLogs 10-block range cap on Alchemy free tier
//
// The endpoint path needs the API key embedded:
// https://eth-mainnet.g.alchemy.com/v2/{API_KEY}
//
// We use the Alchemy NFT API key the harness already has wired in.
// Operator override via DISCOVERY_RPC_URL env if a paid alternative is
// preferred — but no extra config is required for the default case.
const defaultDiscoveryRPCTemplate = "https://eth-mainnet.g.alchemy.com/v2/%s"

const (
	// Page size for one alchemy_getAssetTransfers call. The max is 1000.
	discoveryMaxCount = 1000

	// discoveryMaxPages caps the pagination depth. 10 pages × 1000
	// transfers = 10k sampled mints, which on the current ETH NFT volume
	// covers roughly 6-12 hours of activity and yields 100+ distinct
	// contracts. After dropping top-3 spam and filtering by min 3 unique
	// recipients, ~50 quality collections remain. Each page = 1 cheap
	// HTTP call (~500ms), so the full discovery is ~5s.
	discoveryMaxPages = 10

	// dropTopForSpam systematically removes the top N from the ranking to
	// shed mega-airdrop / free-mint farmer contracts that always pollute
	// the absolute peak. The first few slots are reliably uninteresting
	// for a metadata-coverage bench (these contracts often lack any
	// off-chain metadata, so all providers tie on them anyway).
	dropTopForSpam = 3

	// minMintsToInclude filters the long tail. ≥3 unique recipients means
	// at least three distinct wallets touched this contract in the sample
	// window — clears the noise floor of one-off bot tests without being
	// so strict that we cap the bench at ~10 collections per cycle.
	minMintsToInclude = 3

	// dynamicCollectionsCount mirrors the static list size so the bench
	// page legend ("50 collections / cycle") stays accurate without YAML
	// churn between modes.
	dynamicCollectionsCount = 50

	discoveryTimeoutMs = 15000
)

type assetTransfersParams struct {
	FromBlock   string   `json:"fromBlock"`
	ToBlock     string   `json:"toBlock"`
	FromAddress string   `json:"fromAddress"`
	Category    []string `json:"category"`
	MaxCount    string   `json:"maxCount"`
	Order       string   `json:"order"`
	PageKey     string   `json:"pageKey,omitempty"`
}

type rawContract struct {
	Address string `json:"address"`
}

type assetTransfer struct {
	BlockNum    string      `json:"blockNum"`
	To          string      `json:"to"`
	RawContract rawContract `json:"rawContract"`
}

type assetTransfersResult struct {
	Transfers []assetTransfer `json:"transfers"`
	PageKey   string          `json:"pageKey,omitempty"`
}

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResp struct {
	Result *assetTransfersResult `json:"result,omitempty"`
	Error  *rpcErr               `json:"error,omitempty"`
}

var discoveryClient = &http.Client{Timeout: time.Duration(discoveryTimeoutMs) * time.Millisecond}

type contractMintCount struct {
	Contract         string
	UniqueRecipients int
	Mints            int
}

// discoverTopMintedCollections is the dynamic-mode entry point. Pulls the
// most recent ERC721 mints from Alchemy via the dedicated
// alchemy_getAssetTransfers endpoint (single call, no log-range hacking),
// groups by contract, ranks by unique recipient count, drops the systematic
// top-of-list spam, and returns up to dynamicCollectionsCount NFTCollection
// seeds. Slug field is empty — resolveAllSlugs fills it at cycle start.
//
// On any fatal error, returns the static COLLECTIONS list as a fallback so
// the cycle still produces data — one stale cycle beats one empty cycle.
func discoverTopMintedCollections(rpcURL string) []NFTCollection {
	endpoint := rpcURL
	if endpoint == "" {
		if cfgAlchemyAPIKeyForDiscovery == "" {
			fmt.Println("[NFT][discovery] no DISCOVERY_RPC_URL and no ALCHEMY_API_KEY — falling back to static list")
			return COLLECTIONS
		}
		endpoint = fmt.Sprintf(defaultDiscoveryRPCTemplate, cfgAlchemyAPIKeyForDiscovery)
	}
	fmt.Printf("[NFT][discovery] pulling last %d ERC721 mints (max %d pages) from alchemy_getAssetTransfers\n",
		discoveryMaxCount*discoveryMaxPages, discoveryMaxPages)
	t0 := time.Now()
	transfers, err := fetchRecentMints(endpoint)
	if err != nil || len(transfers) == 0 {
		fmt.Printf("[NFT][discovery] fetch failed (%v, n=%d) — falling back to static list\n", err, len(transfers))
		return COLLECTIONS
	}
	fmt.Printf("[NFT][discovery] %d transfers fetched in %s\n", len(transfers), time.Since(t0).Round(time.Second))

	ranked := rankByUniqueRecipients(transfers)
	fmt.Printf("[NFT][discovery] %d distinct contracts in sample\n", len(ranked))

	out := make([]NFTCollection, 0, dynamicCollectionsCount)
	skipped := 0
	for i, c := range ranked {
		if i < dropTopForSpam {
			fmt.Printf("[NFT][discovery] skip top-%d %s (%d unique recipients, likely batch mint/airdrop)\n",
				i+1, c.Contract, c.UniqueRecipients)
			skipped++
			continue
		}
		if c.UniqueRecipients < minMintsToInclude {
			break
		}
		out = append(out, NFTCollection{
			Name:        shortContract(c.Contract),
			Contract:    c.Contract,
			OpenSeaSlug: "", // resolveAllSlugs fills this at cycle start
		})
		if len(out) >= dynamicCollectionsCount {
			break
		}
	}
	fmt.Printf("[NFT][discovery] selected %d collections (skipped %d top-of-list, threshold ≥%d unique recipients)\n",
		len(out), skipped, minMintsToInclude)
	if len(out) == 0 {
		fmt.Println("[NFT][discovery] no collections passed filters — falling back to static list")
		return COLLECTIONS
	}
	return out
}

// fetchRecentMints calls alchemy_getAssetTransfers up to discoveryMaxPages
// times, paginating via the returned pageKey, and concatenates the result.
// Order=desc means each page is older than the previous, so we sample the
// most recent N*1000 mints. Bails early on the first page that returns an
// empty pageKey (= reached the bottom) or any error after page 1 (partial
// is fine, we still rank what we got).
func fetchRecentMints(endpoint string) ([]assetTransfer, error) {
	var all []assetTransfer
	pageKey := ""
	for page := 0; page < discoveryMaxPages; page++ {
		batch, nextKey, err := fetchOnePage(endpoint, pageKey)
		if err != nil {
			if page == 0 {
				return nil, err
			}
			fmt.Printf("[NFT][discovery] page %d failed: %v (continuing with %d transfers)\n", page+1, err, len(all))
			break
		}
		all = append(all, batch...)
		if nextKey == "" || len(batch) == 0 {
			break
		}
		pageKey = nextKey
	}
	return all, nil
}

func fetchOnePage(endpoint, pageKey string) ([]assetTransfer, string, error) {
	params := assetTransfersParams{
		FromBlock:   "0x0",
		ToBlock:     "latest",
		FromAddress: "0x0000000000000000000000000000000000000000",
		Category:    []string{"erc721"},
		MaxCount:    fmt.Sprintf("0x%x", discoveryMaxCount),
		Order:       "desc",
		PageKey:     pageKey,
	}
	body, err := json.Marshal(rpcReq{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "alchemy_getAssetTransfers",
		Params:  []any{params},
	})
	if err != nil {
		return nil, "", fmt.Errorf("marshal: %w", err)
	}
	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, "", fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)

	resp, err := discoveryClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("do: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", fmt.Errorf("read: %w", err)
	}
	if resp.StatusCode != 200 {
		return nil, "", fmt.Errorf("status %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	var envelope rpcResp
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, "", fmt.Errorf("unmarshal: %w (body: %s)", err, truncate(string(raw), 200))
	}
	if envelope.Error != nil {
		return nil, "", fmt.Errorf("rpc error %d: %s", envelope.Error.Code, envelope.Error.Message)
	}
	if envelope.Result == nil {
		return nil, "", fmt.Errorf("empty result")
	}
	return envelope.Result.Transfers, envelope.Result.PageKey, nil
}

// rankByUniqueRecipients aggregates transfers into (contract, unique-to-count)
// pairs sorted desc. Unique recipients (rather than raw transfer count)
// dedupes single-bot airdrops that would otherwise dominate the leaderboard.
func rankByUniqueRecipients(transfers []assetTransfer) []contractMintCount {
	type acc struct {
		mints int
		to    map[string]struct{}
	}
	by := map[string]*acc{}
	for _, t := range transfers {
		addr := strings.ToLower(t.RawContract.Address)
		if addr == "" {
			continue
		}
		a := by[addr]
		if a == nil {
			a = &acc{to: map[string]struct{}{}}
			by[addr] = a
		}
		a.mints++
		if t.To != "" {
			a.to[strings.ToLower(t.To)] = struct{}{}
		}
	}
	out := make([]contractMintCount, 0, len(by))
	for addr, a := range by {
		out = append(out, contractMintCount{
			Contract:         addr,
			UniqueRecipients: len(a.to),
			Mints:            a.mints,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UniqueRecipients != out[j].UniqueRecipients {
			return out[i].UniqueRecipients > out[j].UniqueRecipients
		}
		return out[i].Mints > out[j].Mints
	})
	return out
}

// shortContract returns "0xabcdef…1234" for log-line readability.
func shortContract(addr string) string {
	if len(addr) <= 14 {
		return addr
	}
	return addr[:10] + "…" + addr[len(addr)-4:]
}
