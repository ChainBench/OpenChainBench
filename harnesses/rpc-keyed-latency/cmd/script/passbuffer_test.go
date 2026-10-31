package main

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// La matrice exportee est la sortie d'UNE passe complete.
//
// Ce qui est verifie n'est pas que le tampon stocke, c'est que RIEN n'est
// visible avant le flush. C'est la difference qui comptait: apres un
// redemarrage, une lecture a mi-passe lisait une part sur un ensemble de
// cellules incomplet, 95,24 % la ou la passe finie lisait 95,92 %.
func TestPassBufferPublishesNothingBeforeFlush(t *testing.T) {
	e := Endpoint{Provider: "bufprov", Chain: "bufchain", Kind: "evm"}
	before := testutil.CollectAndCount(rpcAPISupported)
	beforeBounds := testutil.CollectAndCount(rpcGetLogsMaxRange)

	buf := &passBuffer{}
	buf.verdict(e, "api_one", verdictServed, 12.5, time.Now())
	buf.verdict(e, "api_two", verdictUnsupported, 0, time.Now())
	buf.rangeBound(e, "address", boundRefused, 10_000)

	if got := testutil.CollectAndCount(rpcAPISupported); got != before {
		t.Fatalf("une cellule est apparue avant le flush (%d -> %d)", before, got)
	}
	if got := testutil.CollectAndCount(rpcGetLogsMaxRange); got != beforeBounds {
		t.Fatalf("une fenetre est apparue avant le flush (%d -> %d)", beforeBounds, got)
	}

	cells, bounds := buf.flush()
	if cells != 2 || bounds != 1 {
		t.Fatalf("le flush annonce %d cellules et %d fenetre(s), attendu 2 et 1", cells, bounds)
	}
	if got := testutil.CollectAndCount(rpcAPISupported); got != before+2 {
		t.Fatalf("le flush n a pas publie les deux cellules (%d -> %d)", before, got)
	}
	if got := testutil.ToFloat64(rpcAPISupported.WithLabelValues(
		e.Provider, e.Chain, "api_one", currentRegion, tierKeyed)); got != 1 {
		t.Errorf("la capacite servie lit %v, attendu 1", got)
	}
	if got := testutil.ToFloat64(rpcAPISupported.WithLabelValues(
		e.Provider, e.Chain, "api_two", currentRegion, tierKeyed)); got != 0 {
		t.Errorf("la capacite refusee lit %v, attendu 0", got)
	}
	if got := testutil.ToFloat64(rpcGetLogsMaxRange.WithLabelValues(
		e.Provider, e.Chain, "address", boundRefused, currentRegion, tierKeyed)); got != 10_000 {
		t.Errorf("la fenetre lit %v, attendu 10000", got)
	}
}

// L'estampille voyage avec la mesure et n'est pas prise au flush.
//
// Sinon toutes les cellules dateraient de la fin de la passe, et la colonne
// « Hours since check » mesurerait le flush au lieu de la fraicheur. L'erreur
// irait jusqu'a la duree d'une passe, soit environ dix-sept minutes.
func TestPassBufferKeepsTheProbeTimestamp(t *testing.T) {
	e := Endpoint{Provider: "stampprov", Chain: "stampbuf", Kind: "evm"}
	probedAt := time.Now().Add(-14 * time.Minute)

	buf := &passBuffer{}
	buf.verdict(e, "stamped_api", verdictServed, 5, probedAt)
	buf.flush()

	got := testutil.ToFloat64(rpcAPILastProbe.WithLabelValues(
		e.Provider, e.Chain, "stamped_api", currentRegion, tierKeyed))
	want := float64(probedAt.Unix())
	if got != want {
		t.Fatalf("estampille %v, attendu %v (ecart %.0f s): la colonne de "+
			"fraicheur mesurerait le flush", got, want, got-want)
	}
}

// Un verdict que le sink ne reconnait pas n'ecrit rien, par le tampon comme en
// direct. Les cas « on n'a pas trouve » en dependent: ils doivent laisser la
// cellule vide plutot que publier un zero.
func TestBufferedUnknownVerdictWritesNothing(t *testing.T) {
	e := Endpoint{Provider: "unkprov", Chain: "unkchain", Kind: "evm"}
	before := testutil.CollectAndCount(rpcAPISupported)

	buf := &passBuffer{}
	buf.verdict(e, "unknown_api", verdictUnknown, 7, time.Now())
	buf.verdict(e, "deferred_api", verdictAuthDeferred, 7, time.Now())
	buf.flush()

	if got := testutil.CollectAndCount(rpcAPISupported); got != before {
		t.Fatalf("un verdict non definitif a publie une cellule (%d -> %d)", before, got)
	}
}
