package main

import "testing"

// Ce que le chiffre VEUT DIRE, et pas seulement ce qu'il vaut.
//
// L'audit adversarial du 2026-10-30 a trouve le cout de ne pas le dire:
// Quicknode publie 10 000 sur sept chaines apres une erreur HTTP au barreau
// 100 000, et GetBlock 1 000 sur Arc apres une au barreau 2 000. Les deux se
// lisent comme le garde du provider. L'un ou l'autre l'est peut-etre, et rien
// dans le chiffre ne disait qu'on n'avait jamais demande plus haut.

func TestBoundSaysWhatStoppedTheClimb(t *testing.T) {
	// Un refus du provider: le chiffre est son garde.
	refused := climb(func(span uint64) (bool, bool) { return span <= 10_000, true })
	if refused.bound != boundRefused {
		t.Fatalf("refus: bound=%q, attendu %q", refused.bound, boundRefused)
	}
	if refused.best != 10_000 {
		t.Fatalf("refus: best=%d, attendu 10000", refused.best)
	}

	// Tous les barreaux passent: le garde est au-dessus du dernier.
	top := climb(func(uint64) (bool, bool) { return true, true })
	if top.bound != boundTop {
		t.Fatalf("sommet: bound=%q, attendu %q", top.bound, boundTop)
	}

	// Notre propre appel echoue plus haut: plancher, pas limite.
	failed := climb(func(span uint64) (bool, bool) {
		if span <= 2_000 {
			return true, true
		}
		return false, false
	})
	if failed.bound != boundFailed {
		t.Fatalf("echec: bound=%q, attendu %q", failed.bound, boundFailed)
	}
	if failed.best != 2_000 || !failed.publish {
		t.Fatalf("echec: best=%d publish=%v, attendu 2000 publie", failed.best, failed.publish)
	}
}

func TestTheThreeBoundsAreDistinct(t *testing.T) {
	// Un garde-fou contre la fusion de deux d'entre eux par megarde: la
	// distinction est toute la valeur du label.
	if boundRefused == boundFailed || boundRefused == boundTop || boundFailed == boundTop {
		t.Fatal("deux bornes partagent une valeur, donc le label ne distingue plus rien")
	}
	for _, b := range []string{boundRefused, boundFailed, boundTop} {
		if b == "" {
			t.Fatal("une borne vide se confond avec une serie sans label")
		}
	}
}

func TestNothingPublishedCarriesNoBoundWorthReading(t *testing.T) {
	// Premier barreau indefini: rien n'est etabli, donc rien n'est publie.
	out := climb(func(uint64) (bool, bool) { return false, false })
	if out.publish {
		t.Fatal("rien d'etabli ne doit rien publier")
	}
	if out.best != 0 {
		t.Fatalf("best=%d sans rien d'accepte", out.best)
	}
}

func TestAThrottleIsNotAWidthRefusal(t *testing.T) {
	// Un throttle dit qu'on a demande trop souvent, pas que la fenetre est
	// trop large. Le lire comme une limite publierait notre cadence comme
	// leur politique, ce qui est la meme faute que de classer un timeout.
	for _, msg := range []string{
		"rate limit exceeded",
		"Rate-Limit reached, slow down",
		"429 Too Many Requests",
		"your request limit has been reached",
		"request throttled",
		"quota exceeded for this key",
	} {
		body := []byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"` + msg + `"}}`)
		accepted, definitive := acceptedSpan(body)
		if definitive {
			t.Fatalf("%q lu comme definitif: l'echelle publierait notre cadence comme une limite", msg)
		}
		if accepted {
			t.Fatalf("%q lu comme accepte", msg)
		}
	}
}

func TestARealWidthRefusalStaysDefinitive(t *testing.T) {
	// La liste des throttles est volontairement etroite: tout ce qui n'est
	// pas reconnu reste un refus de plage, parce que c'est le cas courant.
	// Les trois messages ci-dessous ont ete releves en production.
	for _, msg := range []string{
		"eth_getLogs range of 501 blocks exceeds the 500-block limit",
		"Block range is too large",
		"Block range limit exceeded",
	} {
		body := []byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"` + msg + `"}}`)
		_, definitive := acceptedSpan(body)
		if !definitive {
			t.Fatalf("%q lu comme indefini: l'echelle ne publierait plus la mesure qu'elle cherche", msg)
		}
	}
}
