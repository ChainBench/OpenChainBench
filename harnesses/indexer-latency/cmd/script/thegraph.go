package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// The Graph poller.
//
// The Graph only serves what subgraphs index, so we cannot ask it for a
// raw USDC Transfer log. Probed entity instead: the canonical Uniswap
// V3 Ethereum subgraph queried WITH a block constraint pinned to the
// reference block N. graph-node rejects block-constrained queries until
// the subgraph has indexed block N ("only indexed up to block ..."), so
// a successful data response is exactly "block N data queryable". This
// per-provider entity asymmetry is disclosed in the bench methodology;
// the measured question (block N queryable at T?) is identical.
//
// Gateway free plan (100k queries/month) requires GRAPH_API_KEY; the
// key travels in the Authorization header, never in the URL.

const uniswapV3SubgraphID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV"

func checkTheGraph(bn uint64, _ string) (bool, error) {
	apiCalls.WithLabelValues("thegraph").Inc()
	q := fmt.Sprintf(`{"query":"{ pools(block: {number: %d}, first: 1) { id } }"}`, bn)
	u := "https://gateway.thegraph.com/api/subgraphs/id/" + uniswapV3SubgraphID
	req, err := http.NewRequest("POST", u, strings.NewReader(q))
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+graphAPIKey())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")
	resp, err := httpClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return false, err
	}
	if resp.StatusCode != 200 {
		return false, fmt.Errorf("status %d", resp.StatusCode)
	}
	var out struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return false, err
	}
	if len(out.Errors) > 0 {
		msg := strings.ToLower(out.Errors[0].Message)
		// graph-node's "block N not yet indexed" family of errors is the
		// expected pre-sync answer, not an API failure.
		if strings.Contains(msg, "indexed up to") || strings.Contains(msg, "has only indexed") || strings.Contains(msg, "missing block") || strings.Contains(msg, "not yet") {
			return false, nil
		}
		return false, fmt.Errorf("graphql: %s", out.Errors[0].Message)
	}
	return len(out.Data) > 0 && string(out.Data) != "null", nil
}
