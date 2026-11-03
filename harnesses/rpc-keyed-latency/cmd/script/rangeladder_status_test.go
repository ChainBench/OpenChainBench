package main

import "testing"

// Un refus de largeur porte par un statut non-200, et tout ce qui lui
// ressemble sans en etre.
//
// Les deux premiers cas sont des mesures du 2026-10-30, pas des inventions:
// QuickNode refuse 100 000 blocs avec un 413 et getblock sur arc avec un 403.
// Les cas negatifs sont la pour la raison inverse: sur un non-200 on ne peut
// pas raisonner comme sur un 200, ou une erreur JSON-RPC signifie forcement un
// refus de largeur. Un 401 ne parle pas de fenetres et un 502 ne parle de
// rien, donc le test est POSITIF: le corps doit le dire.
func TestAcceptedSpanStatus(t *testing.T) {
	definitive := []string{
		`{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"eth_getLogs is limited to a 10,000 range"}}`,
		`{"error":{"message":"Requested block range exceeds the limits (1500 blocks)"}}`,
		// Un corps en texte nu doit marcher aussi: rien ne garantit du JSON
		// derriere un statut d'erreur.
		"eth_getLogs is limited to a 10,000 range",
		"Block range is too large",
	}
	for _, body := range definitive {
		if !acceptedSpanStatus([]byte(body)) {
			t.Errorf("un refus de largeur doit etre definitif: %q", body)
		}
	}

	indefinite := []string{
		"",
		`{"error":{"message":"Unauthorized"}}`,
		`{"error":{"message":"invalid api key"}}`,
		`{"error":{"message":"Payment Required: credits exhausted"}}`,
		// Le throttle est verifie avant la largeur, et son message parle de
		// requetes, pas de blocs.
		`{"error":{"message":"too many requests, rate limit exceeded"}}`,
		`{"error":{"message":"exceeded the quota for this plan"}}`,
		"<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>",
		// Un bloc unique introuvable n'est pas une limite de fenetre: il y a
		// bien "block", mais aucune borne.
		`{"error":{"message":"block not found"}}`,
	}
	for _, body := range indefinite {
		if acceptedSpanStatus([]byte(body)) {
			t.Errorf("ceci ne dit pas une largeur refusee: %q", body)
		}
	}
}

// Le piege que l'ordre des deux tests evite: un message de throttle qui
// contient quand meme les deux familles de mots. Il faut que le throttle gagne,
// sinon on publie notre cadence comme leur fenetre.
func TestRateLimitWinsOverRangeWords(t *testing.T) {
	body := `{"error":{"message":"request limit reached: your plan allows 25 blocks per second"}}`
	if acceptedSpanStatus([]byte(body)) {
		t.Fatal("un throttle publierait notre cadence comme leur fenetre")
	}
}
