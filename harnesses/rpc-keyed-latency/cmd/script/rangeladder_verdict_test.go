package main

import "testing"

// Les messages ci-dessous sont les vrais, relevés en production le 2026-10-30
// après que l'échelle eut publié zéro lecture sur seize pour dwellir et deux
// sur quatorze pour getblock.
//
// La cause était la règle de verdict, pas les providers. `classifyError` ne
// connaît que deux familles, méthode absente et méthode hors plan, et rend
// "inconnu" pour tout le reste afin qu'un message de rate-limit ne passe jamais
// pour une preuve de capacité. Cette prudence est juste là-bas et fausse ici :
// un refus de plage n'appartient à aucune des deux familles, donc chaque refus
// que l'échelle cherchait était lu comme "on n'a pas pu savoir".
func TestRangeRefusalsAreVerdictsNotUnknowns(t *testing.T) {
	for _, tc := range []struct {
		name, body string
	}{
		{
			"dwellir, mesuré",
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"eth_getLogs range of 2001 blocks exceeds the 500-block limit"}}`,
		},
		{
			"getblock, mesuré",
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32062,"message":"Block range is too large"}}`,
		},
		{
			"chainstack, mesuré",
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Block range limit exceeded"}}`,
		},
		{
			"publicnode refuse la forme entière, mesuré",
			`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Please specify an address in your request"}}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			accepted, definitive := acceptedSpan([]byte(tc.body))
			if !definitive {
				t.Fatal("lu comme indéfini : l'échelle ne publierait rien alors que le provider a répondu")
			}
			if accepted {
				t.Fatal("lu comme accepté : la plage serait publiée plus large qu'elle n'est")
			}
		})
	}
}

func TestEmptyArrayIsTheExpectedSuccess(t *testing.T) {
	// Les filtres ne matchent rien par construction, donc un tableau vide est
	// la réussite normale et non une réponse douteuse.
	accepted, definitive := acceptedSpan([]byte(`{"jsonrpc":"2.0","id":1,"result":[]}`))
	if !accepted || !definitive {
		t.Fatalf("tableau vide lu comme (accepté=%v, définitif=%v), attendu les deux vrais", accepted, definitive)
	}
}

func TestUnreadableRepliesStayIndefinite(t *testing.T) {
	// Le seul cas indéfini qui reste. Un corps illisible ou un résultat qui
	// n'est pas une liste ne dit rien sur la politique de plage du provider, et
	// en déduire une limite publierait notre confusion comme leur règle.
	for _, body := range []string{
		`pas du json`,
		`{"jsonrpc":"2.0","id":1}`,
		`{"jsonrpc":"2.0","id":1,"result":"0x"}`,
		`{"jsonrpc":"2.0","id":1,"result":{}}`,
	} {
		if _, definitive := acceptedSpan([]byte(body)); definitive {
			t.Fatalf("%q lu comme définitif", body)
		}
	}
}

func TestRungsReachBelowTheMeasuredLimits(t *testing.T) {
	// dwellir plafonne à 500 et getblock sur arc à 1500. Une échelle dont le
	// premier barreau est au-dessus de la limite d'un provider ne peut publier
	// que zéro pour lui, et zéro ne distingue pas 500 de 50.
	if getLogsRungs[0] > 100 {
		t.Fatalf("premier barreau à %d : trop haut pour mesurer une limite basse", getLogsRungs[0])
	}
	var has500 bool
	for _, r := range getLogsRungs {
		if r == 500 {
			has500 = true
		}
	}
	if !has500 {
		t.Fatal("pas de barreau à 500 : la limite mesurée de dwellir tomberait entre deux barreaux et serait publiée trop basse")
	}
	// Et le coût reste borné : au pire sept appels par forme et par passe.
	if len(getLogsRungs) > 8 {
		t.Fatalf("%d barreaux : chacun est un appel par forme et par passe", len(getLogsRungs))
	}
}

func TestDwellirClimbsToFiveHundred(t *testing.T) {
	// Le cas complet, bout en bout sur la règle d'arrêt : accepte 100, accepte
	// 500, refusé à 1000. Trois appels, et 500 publié.
	out := climb(func(span uint64) (bool, bool) {
		if span <= 500 {
			return true, true
		}
		return acceptedSpan([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"eth_getLogs range of 2001 blocks exceeds the 500-block limit"}}`))
	})
	if out.best != 500 || !out.publish {
		t.Fatalf("best=%d publish=%v, attendu 500 publié", out.best, out.publish)
	}
	if out.calls != 3 {
		t.Fatalf("%d appels, attendu 3", out.calls)
	}
}
