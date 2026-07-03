// agg.go — in-memory aggregation per (day, builder, coin).
//
// One DayAggregator is created per (builder, day) parse, populated by
// streaming the CSV through parse.go, then flushed atomically into
// DuckDB by store.go. Holding only aggregates (not raw rows) keeps
// memory bounded at O(unique_coins * unique_users) per builder/day.
package script

// AggKey identifies a single output row in builder_daily_aggregates.
type AggKey struct {
	Day     string // YYYY-MM-DD
	Builder string // lowercased 0x address
	Asset   string // coin symbol
}

// AggValue holds the running sums for one AggKey.
type AggValue struct {
	VolumeUSD   float64
	FeesUSD     float64
	FillCount   int64
	uniqueUsers map[string]struct{}
}

// UniqueUsers returns the cardinality without exposing the internal set.
func (a *AggValue) UniqueUsers() int64 { return int64(len(a.uniqueUsers)) }

// DayAggregator buckets fills by (asset). The day + builder dimensions
// are fixed at construction time so we only key on coin.
type DayAggregator struct {
	Day     string
	Builder string
	buckets map[string]*AggValue
}

func NewDayAggregator(day, builder string) *DayAggregator {
	return &DayAggregator{Day: day, Builder: builder, buckets: map[string]*AggValue{}}
}

// Add folds one fill into the running aggregates.
func (a *DayAggregator) Add(f Fill) {
	b, ok := a.buckets[f.Coin]
	if !ok {
		b = &AggValue{uniqueUsers: map[string]struct{}{}}
		a.buckets[f.Coin] = b
	}
	b.VolumeUSD += f.Px * f.Sz
	b.FeesUSD += f.BuilderFee
	b.FillCount++
	if f.User != "" {
		b.uniqueUsers[f.User] = struct{}{}
	}
}

// Rows returns the final (key, value) pairs ready for upsert.
func (a *DayAggregator) Rows() []AggRow {
	out := make([]AggRow, 0, len(a.buckets))
	for asset, v := range a.buckets {
		out = append(out, AggRow{
			Key:         AggKey{Day: a.Day, Builder: a.Builder, Asset: asset},
			VolumeUSD:   v.VolumeUSD,
			FeesUSD:     v.FeesUSD,
			FillCount:   v.FillCount,
			UniqueUsers: v.UniqueUsers(),
		})
	}
	return out
}

// AggRow is the flat form used by store.go for batch inserts.
type AggRow struct {
	Key         AggKey
	VolumeUSD   float64
	FeesUSD     float64
	FillCount   int64
	UniqueUsers int64
}
