package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

// The lane exists to answer one question faster than the capability pass can:
// does the work term separate providers at all?
//
// Measured from a laptop on 2026-10-30, eleven keyed cells, three repeats:
//
//	alchemy     ethereum/base/arbitrum/bnb/polygon/hyperliquid/robinhood  +44..+66 ms
//	quicknode   robinhood                                                 +39 ms
//	chainstack  ethereum/robinhood                                        +56..+60 ms
//	chainstack  arc                                                       +18 ms
//
// A 48 ms spread between providers, against 109 ms of dispersion inside the
// measuring instrument itself. So from that vantage the answer is no, and the
// deltas are nevertheless suggestive: Arc, a young low-traffic chain, costs a
// fifth of what Ethereum costs for the same fifty state reads. Whether the
// spread survives from a datacentre with hundreds of samples is the question,
// and sample count is the only variable this lane controls.
//
// The guards below are about cost, because the instruction that came with this
// was to watch the plans.

func TestHeavyLaneDefaultCadenceIsAffordable(t *testing.T) {
	os.Unsetenv("RPC_KEYED_HEAVY_LANE_SECONDS")
	got := heavyLaneInterval()
	if got != 2*time.Hour {
		t.Fatalf("default cadence %s, want 2h", got)
	}
	// FOUR calls per endpoint per pass, not two: each leg is primed, so a
	// leg costs an unmeasured call plus the measured one. The first version
	// of this guard counted two and therefore allowed twice what it meant
	// to.
	//
	// Still expressed per REGION, because that is how the budgets are
	// written, and the lane now runs in all three rather than in us-east
	// alone. At two hours a provider's eight EVM cells cost 11,520 a month
	// per region, which is why the cadence moved from one hour when the
	// region count tripled.
	perMonth := int(4 * (30 * 24 * time.Hour / got) * 8)
	// Infura has the tightest budget that actually carries EVM cells
	// (370,000 per region per month) and the tip probe already spends about
	// 173,000 of it.
	if perMonth > 20_000 {
		t.Fatalf("%d requests a month for one provider's eight cells: that is no longer a rounding error against a 370k budget", perMonth)
	}
}

func TestHeavyLaneRefusesALoadTestCadence(t *testing.T) {
	// The env override exists so the cadence can be tuned from Railway
	// without a rebuild. Below five minutes this stops measuring the provider
	// and starts measuring what happens when we hammer it, which is both
	// dishonest and a good way to lose a key.
	for _, v := range []string{"1", "30", "299", "-60", "0", "abc"} {
		os.Setenv("RPC_KEYED_HEAVY_LANE_SECONDS", v)
		if got := heavyLaneInterval(); got < 5*time.Minute {
			t.Fatalf("env %q produced %s, which is below the floor", v, got)
		}
	}
	os.Setenv("RPC_KEYED_HEAVY_LANE_SECONDS", "900")
	if got := heavyLaneInterval(); got != 15*time.Minute {
		t.Fatalf("env 900 produced %s, want 15m", got)
	}
	os.Unsetenv("RPC_KEYED_HEAVY_LANE_SECONDS")
}

func TestHeavyLaneProbesAreTheSameTwoAsTheCapabilityPass(t *testing.T) {
	// The lane builds its probes through ethCallProbe, the same constructor
	// the capability pass uses, so the verdict rule and the latency rule
	// cannot drift between the two cadences. If they did, the delta would be
	// computed across two different definitions of "served".
	light := ethCallProbe(lightCallAPI, lightCallSubCalls)
	heavy := ethCallProbe(heavyCallAPI, heavyCallSubCalls)
	var laneLight, laneHeavy bool
	for _, pr := range coverageProbes {
		switch pr.API {
		case light.API:
			laneLight = true
		case heavy.API:
			laneHeavy = true
		}
	}
	if !laneLight || !laneHeavy {
		t.Fatal("the lane's api labels must match the capability pass's, or the two cadences write different series")
	}
	lp, _ := light.body(0)
	hp, _ := heavy.body(0)
	if lp == hp {
		t.Fatal("both legs send the same payload: there is no work term to measure")
	}
}

// La voie lourde ne doit PAS etre bornee a la region de la passe de capacite.
//
// Elle l'etait, et le board en a souffert d'une maniere qui ne ressemblait pas
// a un bug: l'onglet Heavy montrait us-east seul a cote d'un Pooled moyenne
// sur trois regions. Mesure du 2026-11-03, chainstack sur ethereum, la sonde
// de tete lit 3,33 ms en us-east, 9,02 en eu-west et 41,97 a Singapour, soit
// 18,1 une fois moyennee, contre 4,29 pour l'appel lourd en us-east. La page
// affirmait donc qu'un appel de cinquante lectures etait quatre fois plus
// rapide qu'une lecture de bloc.
//
// Le test ne peut pas lancer la goroutine, mais il peut verifier que la
// fonction ne consulte plus la porte de la couverture. Une regression ici
// serait invisible autrement: la voie tournerait, publierait, et seul le
// rapport entre deux onglets trahirait le perimetre.
func TestHeavyLaneIsNotGatedOnTheCoverageRegion(t *testing.T) {
	src, err := os.ReadFile("heavycall.go")
	if err != nil {
		t.Fatalf("heavycall.go illisible: %v", err)
	}
	body := string(src)
	i := strings.Index(body, "func StartHeavyLane(")
	if i < 0 {
		t.Fatal("StartHeavyLane introuvable")
	}
	rest := body[i:]
	j := strings.Index(rest, "go func()")
	if j < 0 {
		t.Fatal("corps de StartHeavyLane introuvable")
	}
	// Les lignes de commentaire sont retirees avant la recherche: le
	// commentaire qui explique le defaut NOMME coverageEnabled(), et la
	// premiere version de ce test se declenchait sur sa propre
	// documentation.
	var code []string
	for _, line := range strings.Split(rest[:j], "\n") {
		if t := strings.TrimSpace(line); !strings.HasPrefix(t, "//") {
			code = append(code, line)
		}
	}
	if strings.Contains(strings.Join(code, "\n"), "coverageEnabled()") {
		t.Fatal("la voie lourde est de nouveau bornee a la region de la couverture: " +
			"l onglet Heavy afficherait une region a cote d un Pooled qui en moyenne trois")
	}
}
