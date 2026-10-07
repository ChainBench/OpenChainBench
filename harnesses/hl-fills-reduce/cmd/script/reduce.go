package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// hoursInWholeDay is how many hourly files a day has when the node was up for
// all of it. A day short of this is published with Complete=false rather than
// withheld: a partial day is still the best figure available for the hours it
// covers, and the consumer needs to know which it is holding. The mistake
// this guards against is the one the public export makes, where a half day
// and a whole day look identical once summed.
const hoursInWholeDay = 24

// UserAgg is one wallet's activity through one builder on one day. Same
// four fields the CSV path folds out of builder_fills, so a consumer cannot
// tell which source a day came from by its shape.
type UserAgg struct {
	Vol   float64 `json:"v"`
	Pnl   float64 `json:"p"`
	Fee   float64 `json:"f"`
	Fills int     `json:"n"`
}

// Totals is one builder's activity on one UTC day.
type Totals struct {
	VolumeUSD float64 `json:"v"`
	FeesUSD   float64 `json:"f"`
	Fills     int     `json:"n"`
	Taker     int     `json:"t"`
	// LastFill is the unix second of this builder's last fill that day. The
	// consumer uses it to tell a short day from a quiet evening.
	LastFill int64 `json:"l"`
	// CoinVol is notional per coin, for the per-builder coin distribution.
	CoinVol map[string]float64 `json:"c"`
	// Users is every distinct wallet that traded through this builder that
	// day, with its aggregates. Carried per wallet rather than as a count
	// because the consumer unions days into 7d and 30d windows, and a wallet
	// active on five days is one wallet. A count cannot be unioned.
	Users map[string]*UserAgg `json:"u"`
}

// reduceSchema is the shape version of a written day. Bump it whenever the
// fields change, so days reduced under an older shape are re-reduced instead
// of being served to a consumer that will read zeros out of them. A missing
// field decodes silently in Go, which is exactly the kind of quiet wrong
// answer this whole piece of work exists to stop producing.
const reduceSchema = 2

// Day is the reduced form of one day of the node's fill stream.
type Day struct {
	Schema    int                `json:"schema"`
	Day       string             `json:"day"`
	Hours     int                `json:"hours"`
	Complete  bool               `json:"complete"`
	FirstFill string             `json:"first_fill,omitempty"`
	LastFill  string             `json:"last_fill,omitempty"`
	ReducedAt int64              `json:"reduced_at"`
	Builders  map[string]*Totals `json:"builders"`
}

// fillEvent mirrors only the fields this reads. The node's record carries a
// dozen more (closedPnl, startPosition, twapId...) and decoding them would
// cost real time over four gigabytes a day.
type fillEvent struct {
	Px         string `json:"px"`
	Sz         string `json:"sz"`
	Coin       string `json:"coin"`
	Builder    string `json:"builder"`
	BuilderFee string `json:"builderFee"`
	ClosedPnl  string `json:"closedPnl"`
	Crossed    bool   `json:"crossed"`
	Time       int64  `json:"time"`
}

type blockLine struct {
	BlockTime string            `json:"block_time"`
	Events    []json.RawMessage `json:"events"`
}

type Reducer struct {
	FillsDir string
	OutDir   string
	Mount    string
	Backfill int
}

// outPath is where a reduced day lands. Gzipped because the trader lists
// dominate the size and compress about 4x.
func (r *Reducer) outPath(day string) string {
	return filepath.Join(r.OutDir, day+".json.gz")
}

// Sweep reduces every day that is final, present, and not already reduced.
func (r *Reducer) Sweep() (int, error) {
	entries, err := os.ReadDir(r.FillsDir)
	if err != nil {
		return 0, fmt.Errorf("read fills dir: %w", err)
	}
	cutoff := time.Now().UTC().Add(-settleAfterMidnight).Format("20060102")
	oldest := time.Now().UTC().AddDate(0, 0, -r.Backfill).Format("20060102")

	var days []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		d := e.Name()
		if len(d) != 8 || d >= cutoff || d < oldest {
			// `d >= cutoff` drops today and, in the first 90 minutes after
			// midnight, yesterday: a day still being written would be
			// reduced into a figure that is wrong by however much of it the
			// node had not flushed.
			continue
		}
		days = append(days, d)
	}
	sort.Strings(days)

	n := 0
	for _, d := range days {
		done, err := r.alreadyWhole(d)
		if err == nil && done {
			continue
		}
		if err := r.ReduceDay(d); err != nil {
			return n, fmt.Errorf("day %s: %w", d, err)
		}
		n++
	}
	return n, nil
}

// alreadyWhole reports whether a day is reduced and was whole when reduced.
// A day reduced while the node was mid-outage is re-reduced on a later pass,
// because the node backfills hours it missed once it catches up.
func (r *Reducer) alreadyWhole(day string) (bool, error) {
	d, err := r.LoadDay(day)
	if err != nil {
		return false, err
	}
	if d.Schema != reduceSchema {
		return false, nil // written under an older shape, reduce it again
	}
	if d.Complete {
		return true, nil
	}
	// Not whole when reduced. Re-reduce only if more hours have landed since.
	hours, err := r.hoursPresent(day)
	if err != nil {
		return false, err
	}
	return hours <= d.Hours, nil
}

func (r *Reducer) hoursPresent(day string) (int, error) {
	ents, err := os.ReadDir(dayPath(r.FillsDir, day))
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range ents {
		if !e.IsDir() {
			n++
		}
	}
	return n, nil
}

// ReduceDay walks one day's hourly files and writes the reduced form.
func (r *Reducer) ReduceDay(day string) error {
	dir := dayPath(r.FillsDir, day)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var hours []int
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		h, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		hours = append(hours, h)
	}
	sort.Ints(hours)

	acc := map[string]*Totals{}
	out := &Day{
		Schema:   reduceSchema,
		Day:      day,
		Hours:    len(hours),
		Complete: len(hours) == hoursInWholeDay,
	}

	for _, h := range hours {
		first, last, err := r.reduceHour(filepath.Join(dir, strconv.Itoa(h)), acc)
		if err != nil {
			return fmt.Errorf("hour %d: %w", h, err)
		}
		if first != "" && (out.FirstFill == "" || first < out.FirstFill) {
			out.FirstFill = first
		}
		if last > out.LastFill {
			out.LastFill = last
		}
	}

	out.Builders = acc
	out.ReducedAt = time.Now().Unix()
	return r.write(out)
}

// builderKey is the JSON needle that tells a fill with a builder code from
// the overwhelming majority that have none. Decoding every fill to find out
// costs more than the scan.
var builderKey = []byte(`"builder"`)

func (r *Reducer) reduceHour(path string, acc map[string]*Totals) (string, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	var first, last string
	for sc.Scan() {
		line := sc.Bytes()
		if !bytes.Contains(line, builderKey) {
			continue
		}
		var bl blockLine
		if err := json.Unmarshal(line, &bl); err != nil {
			continue
		}
		touched := false
		for _, raw := range bl.Events {
			var pair []json.RawMessage
			if err := json.Unmarshal(raw, &pair); err != nil || len(pair) != 2 {
				continue
			}
			var fe fillEvent
			if err := json.Unmarshal(pair[1], &fe); err != nil || fe.Builder == "" {
				continue
			}
			var trader string
			if err := json.Unmarshal(pair[0], &trader); err != nil {
				continue
			}
			px, err1 := strconv.ParseFloat(fe.Px, 64)
			sz, err2 := strconv.ParseFloat(fe.Sz, 64)
			if err1 != nil || err2 != nil {
				continue
			}
			fee, _ := strconv.ParseFloat(fe.BuilderFee, 64)
			pnl, _ := strconv.ParseFloat(fe.ClosedPnl, 64)
			notional := px * sz

			b := strings.ToLower(fe.Builder)
			t := acc[b]
			if t == nil {
				t = &Totals{CoinVol: map[string]float64{}, Users: map[string]*UserAgg{}}
				acc[b] = t
			}
			t.VolumeUSD += notional
			t.FeesUSD += fee
			t.Fills++
			if fe.Crossed {
				t.Taker++
			}
			if fe.Coin != "" {
				t.CoinVol[fe.Coin] += notional
			}
			// `time` is milliseconds since epoch on the fill itself, which is
			// the trade's own clock rather than the block's.
			if sec := fe.Time / 1000; sec > t.LastFill {
				t.LastFill = sec
			}
			u := strings.ToLower(trader)
			ua := t.Users[u]
			if ua == nil {
				ua = &UserAgg{}
				t.Users[u] = ua
			}
			ua.Vol += notional
			ua.Fee += fee
			ua.Pnl += pnl
			ua.Fills++
			touched = true
		}
		if touched {
			if first == "" {
				first = bl.BlockTime
			}
			last = bl.BlockTime
		}
	}
	return first, last, sc.Err()
}

func (r *Reducer) write(d *Day) error {
	tmp, err := os.CreateTemp(r.OutDir, d.Day+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	zw := gzip.NewWriter(tmp)
	if err := json.NewEncoder(zw).Encode(d); err != nil {
		tmp.Close()
		return err
	}
	if err := zw.Close(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), r.outPath(d.Day))
}

// LoadDay reads a reduced day back.
func (r *Reducer) LoadDay(day string) (*Day, error) {
	f, err := os.Open(r.outPath(day))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	var d Day
	if err := json.NewDecoder(zr).Decode(&d); err != nil {
		return nil, err
	}
	return &d, nil
}

// freeSpace reports the mount's free fraction, 0..1.
func (r *Reducer) freeSpace() (free, total uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(r.Mount, &st); err != nil {
		return 0, 0
	}
	return st.Bavail * uint64(st.Bsize), st.Blocks * uint64(st.Bsize)
}
