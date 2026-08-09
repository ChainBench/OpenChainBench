package spec

import "time"

// HalfOpenRange enforces [From, To) semantics everywhere.
// No function in this codebase accepts two bare time.Time values for a window.
type HalfOpenRange struct {
	From time.Time // inclusive
	To   time.Time // exclusive
}

func (r HalfOpenRange) Contains(t time.Time) bool {
	return !t.Before(r.From) && t.Before(r.To)
}

type Finality string

const (
	FinalityProvisional Finality = "provisional"
	FinalityFinal       Finality = "final"
)

// FeeEvent is a raw fact in native units. No USD, no float.
type FeeEvent struct {
	DeploymentID string
	EventKey     string // chain:tx_hash:log_index:sub — idempotence key
	Ts           time.Time
	Height       uint64
	Component    string
	Beneficiary  string
	Token        string
	AmountRaw    string // NUMERIC(78,0) as string — never float64
	Decimals     uint8
	Market       string
	Finality     Finality
	Source       string
	Meta         map[string]string
}

type Cursor struct {
	Height    uint64
	BlockHash string
	Ts        time.Time
	Finalized bool
}

// Collector is the only interface collectors implement.
// `to` is EXCLUDED — all windows are [from, to).
type Collector interface {
	Name() string
	Collect(ctx interface{}, deploymentID string, from, to Cursor, out chan<- FeeEvent) (Cursor, error)
}
