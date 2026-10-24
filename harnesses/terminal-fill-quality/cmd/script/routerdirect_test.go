package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	dto "github.com/prometheus/client_model/go"
)

func routerDirect(terminal, direct string) float64 {
	var d dto.Metric
	if cRouterDirect.WithLabelValues(terminal, direct).Write(&d) != nil {
		return -1
	}
	return d.Counter.GetValue()
}

// The share the block-sampled fail rate can see is published: a swap sent
// to the router counts as direct, one sent to the user's own proxy does not.
// On Robinhood Chain on 2026-10-22 that share was 3.1 %, which is why the
// row's fail rate is blind there whatever FAIL_SCAN_BLOCKS says.
func TestRouterDirectShareIsCounted(t *testing.T) {
	const router = "0x5399d94d2cab7c252a6034042e1917a0e5e17a18"
	for _, tc := range []struct {
		to, want string
	}{{router, "yes"}, {"0x00000000000000000000000000000000000000aa", "no"}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				Method string `json:"method"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			switch req.Method {
			case "eth_getTransactionByHash":
				fmt.Fprintf(w, `{"jsonrpc":"2.0","id":1,"result":{"from":"0x67337a62e42f0e021323d4feeec22ddf431aa8ae","to":%q,"value":"0x0","input":"0x"}}`, tc.to)
			case "eth_getTransactionReceipt":
				fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":{"status":"0x1","gasUsed":"0x5208","effectiveGasPrice":"0x1","logs":[]}}`)
			default:
				fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":null}`)
			}
		}))
		saved := originChains
		originChains = append(append([]originChain(nil), originChains...), originChain{id: 999001, slug: "test-direct", rpc: []string{srv.URL}})
		term := evmTerminal{Slug: "test-direct-row", Chain: "test-direct", Routers: []string{router}}
		before := routerDirect(term.Slug, tc.want)
		nativeRow(context.Background(), srv.Client(), term, "0xabc", map[string]float64{}, 0)
		originChains = saved
		srv.Close()
		if routerDirect(term.Slug, tc.want)-before != 1 {
			t.Errorf("tx to %s: direct=%s did not move", tc.to, tc.want)
		}
	}
}
