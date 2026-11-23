package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// Un barreau de N doit demander N BLOCS.
//
// La première version demandait [head-N, head], ce qui fait N+1 blocs inclus.
// Les providers comptent la plage inclusivement et choisissent des limites
// rondes, donc l'erreur n'était pas cosmétique : un provider dont la limite
// valait exactement N refusait le barreau N et publiait celui d'en dessous.
//
// Mesuré contre dwellir sur arbitrum, 2026-10-30 :
//
//	100 blocs  accepté
//	499 blocs  accepté
//	500 blocs  accepté
//	501 blocs  refusé, "range of 501 blocks exceeds the 500-block limit"
//	502 blocs  refusé
//
// Leur limite est 500, l'échelle publiait 100. Facteur cinq, et elle aurait
// fait pareil à tout provider dont la limite tombe sur un barreau, ce qui est
// le cas courant plutôt que l'exception.
func blocksAsked(t *testing.T, filter string) uint64 {
	t.Helper()
	var f struct {
		FromBlock string `json:"fromBlock"`
		ToBlock   string `json:"toBlock"`
	}
	if err := json.Unmarshal([]byte(filter), &f); err != nil {
		t.Fatalf("filtre illisible %q: %v", filter, err)
	}
	lo, err1 := strconv.ParseUint(strings.TrimPrefix(f.FromBlock, "0x"), 16, 64)
	hi, err2 := strconv.ParseUint(strings.TrimPrefix(f.ToBlock, "0x"), 16, 64)
	if err1 != nil || err2 != nil {
		t.Fatalf("bornes illisibles: %q %q", f.FromBlock, f.ToBlock)
	}
	if hi < lo {
		t.Fatalf("fenêtre inversée: %d..%d", lo, hi)
	}
	return hi - lo + 1 // inclusif, comme les providers comptent
}

func TestARungAsksExactlyThatManyBlocks(t *testing.T) {
	const head uint64 = 20_000_000
	for _, sh := range getLogsRangeShapes {
		for _, span := range getLogsRungs {
			lo, hi := rungWindow(head, span)
			got := blocksAsked(t, sh.Filter(lo, hi))
			if got != span {
				t.Fatalf("%s, barreau %d : %d blocs demandés. Un provider dont la limite vaut %d refuserait, et la valeur publiée tomberait d'un barreau",
					sh.Shape, span, got, span)
			}
		}
	}
}

func TestDwellirBoundaryPublishesFiveHundred(t *testing.T) {
	// Le cas complet avec la frontière mesurée : accepte jusqu'à 500 blocs
	// inclus, refuse au-delà. L'échelle doit publier 500, pas 100.
	const head uint64 = 20_000_000
	sh := getLogsRangeShapes[0]
	out := climb(func(span uint64) (bool, bool) {
		lo, hi := rungWindow(head, span)
		blocks := blocksAsked(t, sh.Filter(lo, hi))
		if blocks <= 500 {
			return true, true
		}
		return acceptedSpan([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"eth_getLogs range of 501 blocks exceeds the 500-block limit"}}`))
	})
	if out.best != 500 {
		t.Fatalf("publie %d, attendu 500 : c'est exactement l'écart que le décalage d'un bloc produisait", out.best)
	}
}

func TestYoungChainGuardAllowsAHeadEqualToTheRung(t *testing.T) {
	// head-span+1 vaut 1 quand head == span, ce qui est demandable. Le garde
	// doit donc refuser seulement en dessous, sinon la première chaîne jeune
	// perd un barreau pour rien. Et il doit toujours empêcher le
	// débordement : head-span+1 sur des entiers non signés.
	for _, head := range []uint64{0, 1, 99} {
		if head >= getLogsRungs[0] {
			t.Fatalf("tête de test %d mal choisie", head)
		}
	}
	// Avec head == span, la fenêtre part du bloc 1 et compte span blocs.
	span := getLogsRungs[0]
	lo, hi := rungWindow(span, span)
	got := blocksAsked(t, getLogsRangeShapes[0].Filter(lo, hi))
	if got != span {
		t.Fatalf("tête égale au barreau : %d blocs, attendu %d", got, span)
	}
}
