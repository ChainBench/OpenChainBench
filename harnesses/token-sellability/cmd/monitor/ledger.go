package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
)

// The ledger is one line per token per sweep: what we found, and who was
// willing to route into it at that moment.
//
// It exists because the question this bench is heading for has a time
// dimension that Prometheus cannot hold at this cardinality. "Of the tokens
// KyberSwap quoted, how many rugged in the next 24 hours" needs the quote and
// the rug joined on the token, days apart. One series per token per
// aggregator would be 200 x 5 new series every sweep.
//
// It is also the evidence table. A board that names companies should let a
// reader check the specific contracts rather than take a percentage on trust,
// and the aggregate can be recomputed from these lines by anyone.
//
// Written to the host volume rather than Prometheus, which is why the harness
// moving off Railway mattered.
type ledgerEntry struct {
	At        string `json:"at"`
	Chain     string `json:"chain"`
	Token     string `json:"token"`
	Symbol    string `json:"symbol,omitempty"`
	SameBlock string `json:"sameBlock"`
	Delayed   string `json:"delayed"`
	Why       string `json:"why,omitempty"`
	// ExitQuoteWei is what the sell route promised for the whole holding, in
	// wei of native. Recorded, never scored: a route out worth 4% of the
	// stake that delivers 4% is a thin pool honestly priced, and scoring
	// that as a failed exit is what put USDG in a cohort of traps.
	ExitQuoteWei string            `json:"exitQuoteWei,omitempty"`
	Scoreable    bool              `json:"scoreable"`
	Quoted       map[string]string `json:"quoted"`
}

// writeLedger appends this sweep's observations, one JSON object per line,
// to a file named for the UTC day so a day can be served, hashed or dropped
// on its own.
func writeLedger(dir, chain string, entries []ledgerEntry) {
	if dir == "" || len(entries) == 0 {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[sellability] ledger dir: %v", err)
		return
	}
	name := filepath.Join(dir, fmt.Sprintf("%s-%s.jsonl",
		chain, time.Now().UTC().Format("2006-01-02")))
	f, err := os.OpenFile(name, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("[sellability] ledger open: %v", err)
		return
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	for _, e := range entries {
		if err := enc.Encode(e); err != nil {
			log.Printf("[sellability] ledger write: %v", err)
			return
		}
	}
}

// answer renders one aggregator's reply for the ledger. Three states, not
// two: a refusal and an unanswered request mean opposite things about the
// aggregator and must not collapse into the same word.
func answer(quoted, answered bool) string {
	switch {
	case !answered:
		return "unanswered"
	case quoted:
		return "quoted"
	default:
		return "declined"
	}
}
