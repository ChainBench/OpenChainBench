package main

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// One block line in the node's own shape. Two fills, only the second routed
// through a builder: the overwhelming majority of fills on the chain carry
// no builder code at all, and counting them would turn a builder leaderboard
// into a volume leaderboard for Hyperliquid itself.
const blockWithOneBuilderFill = `{"local_time":"2026-10-06T09:00:00.001Z","block_time":"2026-10-06T08:59:59.8Z","block_number":1,"events":[` +
	`["0xtrader1",{"coin":"BTC","px":"100","sz":"2","side":"A","time":1791277199000,"crossed":true,"fee":"0.5","feeToken":"USDC","closedPnl":"1.5"}],` +
	`["0xtrader2",{"coin":"BTC","px":"100","sz":"3","side":"B","time":1791277199000,"crossed":true,"fee":"0.9","builderFee":"0.6","builder":"0xBUILDER","feeToken":"USDC","closedPnl":"-2.0"}]` +
	`]}`

// A second block for the same builder, same trader, so the wallet merges
// rather than being counted twice.
const blockSameTraderAgain = `{"local_time":"2026-10-06T09:00:01.0Z","block_time":"2026-10-06T09:00:00.9Z","block_number":2,"events":[` +
	`["0xTrader2",{"coin":"ETH","px":"10","sz":"4","side":"A","time":1791277260000,"crossed":false,"fee":"0.1","builderFee":"0.04","builder":"0xbuilder","feeToken":"USDC","closedPnl":"0.5"}]` +
	`]}`

func writeHour(t *testing.T, dir, day, hour, body string) {
	t.Helper()
	d := filepath.Join(dir, day)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(d, hour), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newTestReducer(t *testing.T) *Reducer {
	t.Helper()
	root := t.TempDir()
	fills := filepath.Join(root, "hourly")
	out := filepath.Join(root, "out")
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	return &Reducer{FillsDir: fills, OutDir: out, Mount: root, Backfill: 45}
}

func TestReduceDayFoldsOnlyBuilderFills(t *testing.T) {
	r := newTestReducer(t)
	writeHour(t, r.FillsDir, "20261006", "0", blockWithOneBuilderFill+"\n"+blockSameTraderAgain+"\n")

	if err := r.ReduceDay("20261006"); err != nil {
		t.Fatalf("reduce: %v", err)
	}
	d, err := r.LoadDay("20261006")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if d.Schema != reduceSchema {
		t.Fatalf("schema = %d, want %d", d.Schema, reduceSchema)
	}

	// Addresses are lowercased on the way in, so 0xBUILDER and 0xbuilder are
	// one builder. The node is not consistent about case and a split here
	// would publish one product as two.
	if len(d.Builders) != 1 {
		t.Fatalf("builders = %v, want the one builder, case-folded", keys(d.Builders))
	}
	b := d.Builders["0xbuilder"]
	if b == nil {
		t.Fatalf("builder not keyed lowercase: %v", keys(d.Builders))
	}

	// 100*3 + 10*4. The $200 fill with no builder is not this builder's.
	if b.VolumeUSD != 340 {
		t.Fatalf("volume = %v, want 340", b.VolumeUSD)
	}
	// The builder fee, not the exchange fee: 0.6 + 0.04, never 0.9 + 0.1.
	if b.FeesUSD < 0.639 || b.FeesUSD > 0.641 {
		t.Fatalf("fees = %v, want 0.64 (builderFee, not fee)", b.FeesUSD)
	}
	if b.Fills != 2 {
		t.Fatalf("fills = %v, want 2", b.Fills)
	}
	if b.Taker != 1 {
		t.Fatalf("taker = %v, want 1", b.Taker)
	}
	if b.CoinVol["BTC"] != 300 || b.CoinVol["ETH"] != 40 {
		t.Fatalf("coin volume = %v", b.CoinVol)
	}
	// One wallet traded through both blocks under two spellings.
	if len(b.Users) != 1 {
		t.Fatalf("users = %v, want the one wallet", keys2(b.Users))
	}
	u := b.Users["0xtrader2"]
	if u == nil || u.Fills != 2 || u.Vol != 340 {
		t.Fatalf("wallet did not merge: %+v", u)
	}
	// Per-wallet volume must sum to the builder's, or the percentile panel
	// is drawn against a different total than the headline.
	var sum float64
	for _, ua := range b.Users {
		sum += ua.Vol
	}
	if sum != b.VolumeUSD {
		t.Fatalf("wallet volumes sum to %v, builder says %v", sum, b.VolumeUSD)
	}
	// closedPnl carries through signed: -2.0 + 0.5.
	if u.Pnl > -1.49 || u.Pnl < -1.51 {
		t.Fatalf("pnl = %v, want -1.5", u.Pnl)
	}
	// The fill's own clock, in seconds.
	if b.LastFill != 1791277260 {
		t.Fatalf("last fill = %v, want 1791277260", b.LastFill)
	}
}

// A day is whole only when all 24 hours are there. The consumer refuses a
// partial day outright, so getting this wrong would quietly hand it a
// fraction of a day wearing a whole day's label, which is the exact failure
// the public export makes.
func TestCompletenessCountsHours(t *testing.T) {
	r := newTestReducer(t)
	for h := 0; h < 10; h++ {
		writeHour(t, r.FillsDir, "20261003", itoa(h), blockWithOneBuilderFill+"\n")
	}
	if err := r.ReduceDay("20261003"); err != nil {
		t.Fatal(err)
	}
	d, err := r.LoadDay("20261003")
	if err != nil {
		t.Fatal(err)
	}
	if d.Hours != 10 || d.Complete {
		t.Fatalf("10 hours published as complete=%v hours=%d", d.Complete, d.Hours)
	}

	for h := 10; h < 24; h++ {
		writeHour(t, r.FillsDir, "20261003", itoa(h), blockWithOneBuilderFill+"\n")
	}
	// A day that was partial must be re-reduced once the node backfills it.
	whole, err := r.alreadyWhole("20261003")
	if err != nil {
		t.Fatal(err)
	}
	if whole {
		t.Fatal("a day that gained hours was treated as already done")
	}
	if err := r.ReduceDay("20261003"); err != nil {
		t.Fatal(err)
	}
	d, _ = r.LoadDay("20261003")
	if d.Hours != 24 || !d.Complete {
		t.Fatalf("24 hours published as complete=%v hours=%d", d.Complete, d.Hours)
	}
	if whole, _ := r.alreadyWhole("20261003"); !whole {
		t.Fatal("a whole day is still being re-reduced every sweep")
	}
}

// A day stored under an older shape decodes into zeros field by field in Go,
// silently. The schema number is what stops that reaching a consumer.
func TestOlderSchemaIsReReduced(t *testing.T) {
	r := newTestReducer(t)
	writeHour(t, r.FillsDir, "20261006", "0", blockWithOneBuilderFill+"\n")
	if err := r.ReduceDay("20261006"); err != nil {
		t.Fatal(err)
	}
	d, _ := r.LoadDay("20261006")
	d.Schema = reduceSchema - 1
	if err := r.write(d); err != nil {
		t.Fatal(err)
	}
	whole, err := r.alreadyWhole("20261006")
	if err != nil {
		t.Fatal(err)
	}
	if whole {
		t.Fatal("a day of an older shape was left in place")
	}
}

// Sweep must not touch a day the node is still writing: reducing it caches a
// figure that is wrong by however much had not been flushed.
func TestSweepSkipsUnsettledDays(t *testing.T) {
	r := newTestReducer(t)
	today := nowUTCDay()
	writeHour(t, r.FillsDir, today, "0", blockWithOneBuilderFill+"\n")
	n, err := r.Sweep()
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n != 0 {
		t.Fatalf("sweep reduced %d day(s); today is still being written", n)
	}
}

// An hour file exists because the hour turned, not because the node wrote
// anything into it. A stalled or catching-up node leaves 0-byte files behind,
// and counting them inflates the day's coverage: on 2026-10-13 hour 12 was
// empty while the node was fetching state, and the day would have claimed an
// hour it held nothing for. Coverage is what the consumer uses to decide
// whether to trust a node day over the truncated public export, so an hour
// that holds nothing must not read as an hour that holds something.
func TestEmptyHourFileIsNotCountedAsAnHour(t *testing.T) {
	r := newTestReducer(t)
	const day = "20261012"
	writeHour(t, r.FillsDir, day, "0", blockWithOneBuilderFill+"\n")
	writeHour(t, r.FillsDir, day, "1", "")
	writeHour(t, r.FillsDir, day, "2", blockSameTraderAgain+"\n")

	n, err := r.hoursPresent(day)
	if err != nil {
		t.Fatalf("hoursPresent: %v", err)
	}
	if n != 2 {
		t.Fatalf("hoursPresent counted %d hours; the empty one must not count", n)
	}

	if err := r.ReduceDay(day); err != nil {
		t.Fatalf("reduce: %v", err)
	}
	d, err := r.LoadDay(day)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if d.Hours != 2 {
		t.Fatalf("reduced day reports %d hours; want 2, the empty file excluded", d.Hours)
	}
	// The two counts have to agree, or alreadyWhole compares a file count
	// against a reduced count that never matches and re-reduces for ever.
	whole, err := r.alreadyWhole(day)
	if err != nil {
		t.Fatalf("alreadyWhole: %v", err)
	}
	if !whole {
		t.Fatal("alreadyWhole says the day changed; the empty hour is counted inconsistently between the two paths")
	}
}

// The root filesystem is measured separately from the data volume, because a
// healthy data volume is not evidence that the host is healthy. On 2026-10-08
// this box's root filled to 100% while the data volume sat at 29%, hl-visor
// could not stage the node binary a hardfork required through /tmp, and the
// node froze at the fork height for three days with every disk signal on the
// box reading normal.
func TestRootSpaceIsMeasuredSeparatelyFromTheDataVolume(t *testing.T) {
	r := &Reducer{Mount: t.TempDir()}

	if _, rootTotal := r.rootSpace(); rootTotal == 0 {
		t.Fatal("rootSpace reported no total bytes for /, so the root filesystem would go unmonitored")
	}
	// Both mounts are readable here, so both must report. What the pair buys
	// is that rootSpace reads / rather than r.Mount: one reading serving both
	// is the blind spot these two methods replaced.
	if _, dataTotal := r.freeSpace(); dataTotal == 0 {
		t.Fatal("freeSpace reported no total bytes for the data mount")
	}
}

// An unreadable mount must report zeroes so callers can tell "not measured"
// from "empty". A 0% gauge on a mount nobody could stat is the reassuring
// lie this harness's alerts exist to avoid, which is why serve.go turns
// these zeroes into -1 rather than publishing 0%.
func TestSpaceOnUnreadablePathReportsZeroNotEmpty(t *testing.T) {
	free, total := spaceOn(filepath.Join(t.TempDir(), "no", "such", "mount"))
	if free != 0 || total != 0 {
		t.Fatalf("spaceOn on a missing path gave free=%d total=%d, want 0 and 0", free, total)
	}
}

// writeRebuilt drops a rebuilt day straight into RebuiltDir, the way the
// rebuild tool does.
func writeRebuilt(t *testing.T, r *Reducer, day string, complete, flagged bool, fees float64) {
	t.Helper()
	if err := os.MkdirAll(r.RebuiltDir, 0o755); err != nil {
		t.Fatal(err)
	}
	d := &Day{
		Schema: reduceSchema, Day: day, Hours: 24, Complete: complete, Rebuilt: flagged,
		Builders: map[string]*Totals{"0xb": {FeesUSD: fees}},
	}
	f, err := os.Create(filepath.Join(r.RebuiltDir, day+".json.gz"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zw := gzip.NewWriter(f)
	if err := json.NewEncoder(zw).Encode(d); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
}

// A measured day outranks a rebuilt one, a partial measurement loses to a
// rebuilt whole day, and an unflagged file in the rebuilt directory is not
// served at all.
//
// The listing and the fetch have to agree on all three. An earlier version of
// the fetch opened the reduced file whenever it existed, so a day the listing
// announced as a rebuilt whole day was served as the partial measurement
// instead: the consumer would have summed 11 hours while being told it held 24.
func TestRebuiltDaysOnlyFillGapsAndNeverOutrankAMeasuredDay(t *testing.T) {
	r := newTestReducer(t)
	r.RebuiltDir = filepath.Join(t.TempDir(), "rebuilt")

	// A whole measured day, and a rebuilt one for the same date.
	writeHour(t, r.FillsDir, "20261001", "0", blockWithOneBuilderFill+"\n")
	for h := 1; h < 24; h++ {
		writeHour(t, r.FillsDir, "20261001", itoa(h), blockWithOneBuilderFill+"\n")
	}
	if err := r.ReduceDay("20261001"); err != nil {
		t.Fatalf("reduce: %v", err)
	}
	writeRebuilt(t, r, "20261001", true, true, 999)

	// A partial measured day, with a rebuilt whole day to replace it.
	writeHour(t, r.FillsDir, "20261002", "0", blockWithOneBuilderFill+"\n")
	if err := r.ReduceDay("20261002"); err != nil {
		t.Fatalf("reduce: %v", err)
	}
	writeRebuilt(t, r, "20261002", true, true, 777)

	// A rebuilt day with no measurement at all.
	writeRebuilt(t, r, "20261003", true, true, 555)

	// A file in the rebuilt directory that forgot the flag.
	writeRebuilt(t, r, "20261004", true, false, 111)

	got := map[string]dayInfo{}
	for _, d := range r.availableDays() {
		got[d.Day] = d
	}

	if d := got["20261001"]; d.Rebuilt || !d.Complete {
		t.Fatalf("20261001: measured whole day must win, got rebuilt=%v complete=%v", d.Rebuilt, d.Complete)
	}
	if d := got["20261002"]; !d.Rebuilt || !d.Complete || d.Hours != 24 {
		t.Fatalf("20261002: rebuilt whole day must replace the 1-hour measurement, got %+v", d)
	}
	if d := got["20261003"]; !d.Rebuilt {
		t.Fatalf("20261003: rebuilt day with no measurement must be offered, got %+v", d)
	}
	if _, ok := got["20261004"]; ok {
		t.Fatal("20261004: an unflagged file in the rebuilt directory must not be served")
	}

	// And what the fetch path would open has to match what the listing said.
	if p := r.servePathFor("20261001"); p != r.outPath("20261001") {
		t.Fatalf("20261001 should be served from the reduced dir, got %s", p)
	}
	if p := r.servePathFor("20261002"); p != filepath.Join(r.RebuiltDir, "20261002.json.gz") {
		t.Fatalf("20261002 should be served from the rebuilt dir, got %s", p)
	}
}

// A rebuilt day states how far short it is expected to fall. A file without
// that field would otherwise report 0, which reads as a perfect reconstruction
// and is the most flattering possible lie: the figure would be published as if
// it were measured. Absent means "assume the worst case we have measured".
func TestRebuiltDayWithNoStatedErrorIsNotTreatedAsPerfect(t *testing.T) {
	pct := func(v float64) *float64 { return &v }

	stated := rebuiltInfo("20261013", &Day{
		Hours: 24, Complete: true, Rebuilt: true,
		RebuiltFrom: &RebuiltFrom{ExpectedErrorPct: pct(-0.5), MorningSharePct: 68.7},
	})
	if stated.ExpectedErrorPct != -0.5 || stated.Extrapolated {
		t.Fatalf("a stated error must carry through, got %+v", stated)
	}

	silent := rebuiltInfo("20261014", &Day{Hours: 24, Complete: true, Rebuilt: true})
	if silent.ExpectedErrorPct == 0 {
		t.Fatal("a rebuilt day with no stated error reported 0, which reads as measured")
	}
	if !silent.Extrapolated {
		t.Fatal("a guessed error must be flagged as not measured")
	}
	if silent.ExpectedErrorPct > -28.0 {
		t.Fatalf("the fallback should be the worst case measured, got %.1f", silent.ExpectedErrorPct)
	}

	// A day that states zero means zero, and must not be lumped in with the
	// silent ones. Days replayed from node_fills_by_block read the builder
	// address off the fill record, so there is no attribution to infer and
	// nothing to fall short by. Treating their zero as "unstated" published
	// an exact day as 28.2 per cent short.
	exact := rebuiltInfo("20261018", &Day{
		Hours: 24, Complete: true, Rebuilt: true,
		RebuiltFrom: &RebuiltFrom{ExpectedErrorPct: pct(0), MorningSharePct: 100},
	})
	if exact.ExpectedErrorPct != 0 {
		t.Fatalf("a day stating zero error must report zero, got %.1f", exact.ExpectedErrorPct)
	}
	if exact.Extrapolated {
		t.Fatal("a stated zero is measured, not extrapolated")
	}
}

func keys(m map[string]*Totals) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func keys2(m map[string]*UserAgg) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func itoa(i int) string {
	if i < 10 {
		return string(rune('0' + i))
	}
	return string(rune('0'+i/10)) + string(rune('0'+i%10))
}
