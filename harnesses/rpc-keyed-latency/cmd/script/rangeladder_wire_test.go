package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// L'echelle de bout en bout contre un provider qui refuse par un statut, pas
// par une erreur JSON-RPC.
//
// Ce test existe parce que tester le classifieur seul ne prouve rien d'utile.
// La faute de la veille etait exactement de cette forme: un test du
// constructeur de filtre passait au vert pendant que l'APPELANT demandait un
// bloc de trop. Ici le classifieur peut etre parfait et la mesure rester
// perdue, puisque le corps d'un non-200 etait jete avant de l'atteindre.
//
// Le serveur imite QuickNode mesure le 2026-10-30: il sert jusqu'a 10 000
// blocs et refuse au-dela par un HTTP 413 dont le corps dit la limite. Ce qui
// est verifie est la jauge publiee, c'est-a-dire ce que le spec lit.
func TestLadderReadsARefusalCarriedByAStatus(t *testing.T) {
	const limit = 10_000
	var asked []uint64

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Params []struct {
				FromBlock string `json:"fromBlock"`
				ToBlock   string `json:"toBlock"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Params) == 0 {
			t.Errorf("payload illisible: %v", err)
			w.WriteHeader(500)
			return
		}
		lo, _ := strconv.ParseUint(strings.TrimPrefix(req.Params[0].FromBlock, "0x"), 16, 64)
		hi, _ := strconv.ParseUint(strings.TrimPrefix(req.Params[0].ToBlock, "0x"), 16, 64)
		span := hi - lo + 1
		asked = append(asked, span)
		if span > limit {
			// Le refus de QuickNode, verbatim, avec son statut.
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":1,"error":{"code":-32602,`+
				`"message":"eth_getLogs is limited to a %s range"}}`, "10,000")
			return
		}
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":1,"result":[]}`)
	}))
	defer srv.Close()

	e := Endpoint{Provider: "wiretest", Chain: "wirechain", Kind: "evm", URL: srv.URL}
	probeGetLogsRange(context.Background(), directSink{}, e, 30_000_000)

	for _, shape := range []string{"address", "topics"} {
		got := testutil.ToFloat64(rpcGetLogsMaxRange.WithLabelValues(
			e.Provider, e.Chain, shape, boundRefused, currentRegion, tierKeyed))
		if got != limit {
			t.Errorf("forme %s: la jauge lit %.0f, attendu %d sous bound=%q",
				shape, got, limit, boundRefused)
		}
		// Et surtout pas sous le libelle de l'echec: c'est ce libelle que le
		// matcher du spec exclut, et c'est la que la mesure se perdait.
		if f := testutil.ToFloat64(rpcGetLogsMaxRange.WithLabelValues(
			e.Provider, e.Chain, shape, boundFailed, currentRegion, tierKeyed)); f != 0 {
			t.Errorf("forme %s: publie %.0f sous bound=%q, que le spec n affiche pas",
				shape, f, boundFailed)
		}
	}

	// L'echelle doit s'etre arretee au premier refus et pas avoir continue a
	// grimper: une largeur refusee une fois le reste.
	if len(asked) == 0 {
		t.Fatal("aucun barreau demande")
	}
	for _, span := range asked {
		if span > 100_000 {
			t.Errorf("l echelle a continue apres le refus, jusqu a %d blocs", span)
		}
	}
}
