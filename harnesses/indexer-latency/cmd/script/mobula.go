package main

import (
	"fmt"
	"net/http"
)

// Mobula poller.
//
// Probed entity: the exact USDC Transfer (matched by tx hash) via the
// wallet-transactions endpoint of the RECIPIENT address captured from
// the Transfer log's topics. This is Mobula's indexed wallet-history
// pipeline, the same product surface bench 070 races on Base native
// transfers; here it answers the 084 question (Ethereum ERC-20 event
// time-to-queryable) so the two benches stay complementary, not
// duplicated.
//
// Disclosure (also in the spec methodology): Mobula operates
// OpenChainBench. The poller runs the exact probe/quota rules as every
// other cohort member and the query is keyless-reproducible modulo the
// free API key.
//
// limit=100: probe recipients are arbitrary USDC receivers, sometimes
// exchange hot wallets busy enough to bury a minutes-old tx below a
// short first page. 100 rows keeps burial (a false "not yet") rare;
// residual risk is disclosed as upper-bound semantics.

func checkMobula(ev probeEvent) (bool, error) {
	apiCalls.WithLabelValues("mobula").Inc()
	u := fmt.Sprintf("https://api.mobula.io/api/1/wallet/transactions?wallet=%s&limit=100", ev.Wallet)
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", mobulaAPIKey())
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := httpClient.Do(req)
	if err != nil {
		return false, err
	}
	return bodyContains(resp, ev.TxHash)
}
