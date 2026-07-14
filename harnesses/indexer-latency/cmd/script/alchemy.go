package main

import (
	"fmt"
	"net/http"
	"strings"
)

// Alchemy poller.
//
// Probed entity: the exact USDC Transfer (matched by tx hash) via
// alchemy_getAssetTransfers with fromBlock=toBlock=N and the USDC
// contract filter. This is Alchemy's indexed transfers pipeline (not a
// raw eth_getLogs proxy), which is what apps built on Alchemy's data
// APIs actually consume. ~150 CU/call on the 30M CU/month free tier.
//
// The key rides in the URL path per Alchemy convention; sanitize()
// strips URLs from any logged error so it can never leak.

func checkAlchemy(bn uint64, txHash string) (bool, error) {
	apiCalls.WithLabelValues("alchemy").Inc()
	blk := fmt.Sprintf("0x%x", bn)
	body := fmt.Sprintf(
		`{"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[{"fromBlock":"%s","toBlock":"%s","contractAddresses":["%s"],"category":["erc20"],"maxCount":"0x3e8","withMetadata":false,"excludeZeroValue":false}]}`,
		blk, blk, usdcContract,
	)
	u := "https://eth-mainnet.g.alchemy.com/v2/" + alchemyAPIKey()
	req, err := http.NewRequest("POST", u, strings.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := httpClient.Do(req)
	if err != nil {
		return false, err
	}
	return bodyContains(resp, txHash)
}
