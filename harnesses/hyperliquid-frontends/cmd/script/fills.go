package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
)

// HL node_fills_by_block hourly file schema (one JSON object per line):
//
//   {
//     "local_time": "2026-06-01T15:00:00.073Z",
//     "block_time": "2026-06-01T14:59:59.839Z",
//     "block_number": 1018934794,
//     "events": [
//       [ "<user_addr>", { fill_object } ],
//       ...
//     ]
//   }
//
// Fill object fields used:
//   coin, px, sz, side, time (ms), builderFee, builder, crossed (bool)

type blockBatch struct {
	BlockNumber int64           `json:"block_number"`
	Events      [][]interface{} `json:"events"`
}

type fillObj struct {
	Coin        string `json:"coin"`
	Px          string `json:"px"`
	Sz          string `json:"sz"`
	Side        string `json:"side"`
	Time        int64  `json:"time"`
	Fee         string `json:"fee"`
	BuilderFee  string `json:"builderFee,omitempty"`
	Builder     string `json:"builder,omitempty"`
	DeployerFee string `json:"deployerFee,omitempty"`
	Crossed     bool   `json:"crossed"`
}

// consumeFile reads new bytes from a file (using stored byte cursor) and
// dispatches each builder-attributed fill to its bucket.
func (a *AggState) consumeFile(path string, warm bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return err
	}

	a.mu.Lock()
	cursor := a.fileCursors[path]
	if warm {
		cursor = 0
	}
	a.mu.Unlock()

	if cursor >= info.Size() {
		return nil
	}
	if _, err := f.Seek(cursor, 0); err != nil {
		return err
	}

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1<<20), 16<<20)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var bb blockBatch
		if err := json.Unmarshal(line, &bb); err != nil {
			continue
		}
		for _, ev := range bb.Events {
			if len(ev) < 2 {
				continue
			}
			user, _ := ev[0].(string)
			user = strings.ToLower(user)
			raw, _ := json.Marshal(ev[1])
			var fo fillObj
			if err := json.Unmarshal(raw, &fo); err != nil {
				continue
			}
			px, _ := strconv.ParseFloat(fo.Px, 64)
			sz, _ := strconv.ParseFloat(fo.Sz, 64)
			if px <= 0 || sz <= 0 {
				continue
			}

			// HIP-3 path: a namespaced coin ("xyz:AAPL") attributes the
			// fill to a deployer dex, independently of builder codes.
			if i := strings.IndexByte(fo.Coin, ':'); i > 0 {
				df, _ := strconv.ParseFloat(fo.DeployerFee, 64)
				a.mu.Lock()
				a.ingestHip3Locked(fo.Coin[:i], fo.Coin, user, fo.Time, px*sz, df)
				a.mu.Unlock()
			}

			builder := strings.ToLower(fo.Builder)
			if builder == "" {
				continue
			}
			slug, ok := a.byAddr[builder]
			if !ok {
				continue
			}
			bf, _ := strconv.ParseFloat(fo.BuilderFee, 64)

			a.mu.Lock()
			var devBps float64
			var devValid bool
			if last, ok := a.lastPxByCoin[fo.Coin]; ok && last > 0 {
				devBps = math.Abs(px-last) / last * 10_000
				devValid = true
			}
			a.lastPxByCoin[fo.Coin] = px
			notional := px * sz
			a.fillsByBuilder[slug] = append(a.fillsByBuilder[slug], fill{
				tsMs:       fo.Time,
				user:       user,
				coin:       fo.Coin,
				notional:   notional,
				builderFee: bf,
				crossed:    fo.Crossed,
				devBps:     devBps,
				devValid:   devValid,
			})

			// Hourly bucket for 7d/30d rolling sums. UTC-hour floor of the
			// fill timestamp keys the bucket. Same path serves warmup and
			// live tail (warmup re-zeros file cursors but never reruns the
			// same line twice within a process), so this is the canonical
			// ingestion point.
			tsHour := (fo.Time / 1000 / 3600) * 3600
			byHour, ok := a.hourlyByBuilder[slug]
			if !ok {
				byHour = make(map[int64]*hourlyBucket)
				a.hourlyByBuilder[slug] = byHour
			}
			bk, ok := byHour[tsHour]
			if !ok {
				bk = &hourlyBucket{}
				byHour[tsHour] = bk
			}
			bk.feesUSD += bf
			bk.volumeUSD += notional

			// Per-UTC-day wallet set for the 7d/30d unique-user counts.
			// Same ingestion point as the hourly buckets; the disk
			// backfill seeds history through scanUsersFile instead.
			if user != "" {
				a.addDailyUserLocked(slug, fo.Time, user)
			}
			a.mu.Unlock()
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("scan: %w", err)
	}

	a.mu.Lock()
	a.fileCursors[path] = info.Size()
	a.mu.Unlock()
	return nil
}

// ingestHip3Locked records one HIP-3 fill into the dex's hourly bucket,
// hourly wallet/market sets (24h unions) and daily wallet set (7d/30d).
// Caller must hold a.mu.
func (a *AggState) ingestHip3Locked(dex, coin, user string, tsMs int64, notional, deployerFee float64) {
	tsHour := (tsMs / 1000 / 3600) * 3600
	hours, ok := a.hip3Hourly[dex]
	if !ok {
		hours = make(map[int64]*hip3Bucket)
		a.hip3Hourly[dex] = hours
	}
	bk, ok := hours[tsHour]
	if !ok {
		bk = &hip3Bucket{}
		hours[tsHour] = bk
	}
	bk.feesUSD += deployerFee
	bk.volumeUSD += notional
	bk.fills++

	if user != "" {
		hu, ok := a.hip3HourlyUsers[dex]
		if !ok {
			hu = make(map[int64]map[string]struct{})
			a.hip3HourlyUsers[dex] = hu
		}
		set, ok := hu[tsHour]
		if !ok {
			set = make(map[string]struct{})
			hu[tsHour] = set
		}
		set[user] = struct{}{}

		dayKey := (tsMs / 1000 / 86400) * 86400
		byDay, ok := a.hip3DailyUsers[dex]
		if !ok {
			byDay = make(map[int64]map[string]struct{})
			a.hip3DailyUsers[dex] = byDay
		}
		dset, ok := byDay[dayKey]
		if !ok {
			dset = make(map[string]struct{})
			byDay[dayKey] = dset
		}
		dset[user] = struct{}{}
	}

	hm, ok := a.hip3HourlyMarkets[dex]
	if !ok {
		hm = make(map[int64]map[string]struct{})
		a.hip3HourlyMarkets[dex] = hm
	}
	mset, ok := hm[tsHour]
	if !ok {
		mset = make(map[string]struct{})
		hm[tsHour] = mset
	}
	mset[coin] = struct{}{}

	if tsMs > a.hip3LastFillMs[dex] {
		a.hip3LastFillMs[dex] = tsMs
	}
}

// addDailyUserLocked records a wallet in its builder's UTC-day set.
// Caller must hold a.mu.
func (a *AggState) addDailyUserLocked(slug string, tsMs int64, user string) {
	dayKey := (tsMs / 1000 / 86400) * 86400
	byDay, ok := a.dailyUsersByBuilder[slug]
	if !ok {
		byDay = make(map[int64]map[string]struct{})
		a.dailyUsersByBuilder[slug] = byDay
	}
	set, ok := byDay[dayKey]
	if !ok {
		set = make(map[string]struct{})
		byDay[dayKey] = set
	}
	set[user] = struct{}{}
}

var (
	builderNeedle  = []byte(`"builder":"`)
	deployerNeedle = []byte(`"deployerFee":"`)
)

// scanHistoryFile streams one hourly file extracting builder wallets and
// HIP-3 deployer aggregates into local accumulators, then merges under the
// lock once per file. Unlike consumeFile it stores no fills and moves no
// cursors, so it can sweep the whole retention horizon without touching
// the live-tail state. Lines with neither a builder attribution nor a
// deployer fee are skipped before JSON parsing.
//
// Wallet sets are idempotent and merged for every file. Additive HIP-3
// hour sums are seeded ONLY for files strictly older than the warmup
// horizon (a.backfillCutoffSec), which consumeFile already owns.
func (a *AggState) scanHistoryFile(path string, hourTs int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	seedSums := hourTs < a.backfillCutoffSec

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1<<20), 16<<20)

	builderDays := make(map[string]map[int64]map[string]struct{})
	hip3Days := make(map[string]map[int64]map[string]struct{})
	hip3Sums := make(map[string]map[int64]*hip3Bucket)

	for scanner.Scan() {
		line := scanner.Bytes()
		hasBuilder := bytes.Contains(line, builderNeedle)
		hasDeployer := bytes.Contains(line, deployerNeedle)
		if !hasBuilder && !hasDeployer {
			continue
		}
		var bb blockBatch
		if err := json.Unmarshal(line, &bb); err != nil {
			continue
		}
		for _, ev := range bb.Events {
			if len(ev) < 2 {
				continue
			}
			user, _ := ev[0].(string)
			user = strings.ToLower(user)
			raw, _ := json.Marshal(ev[1])
			var fo fillObj
			if err := json.Unmarshal(raw, &fo); err != nil {
				continue
			}
			dayKey := (fo.Time / 1000 / 86400) * 86400

			if i := strings.IndexByte(fo.Coin, ':'); i > 0 {
				dex := fo.Coin[:i]
				if user != "" {
					byDay, ok := hip3Days[dex]
					if !ok {
						byDay = make(map[int64]map[string]struct{})
						hip3Days[dex] = byDay
					}
					set, ok := byDay[dayKey]
					if !ok {
						set = make(map[string]struct{})
						byDay[dayKey] = set
					}
					set[user] = struct{}{}
				}
				if seedSums {
					px, _ := strconv.ParseFloat(fo.Px, 64)
					sz, _ := strconv.ParseFloat(fo.Sz, 64)
					if px > 0 && sz > 0 {
						df, _ := strconv.ParseFloat(fo.DeployerFee, 64)
						fillHour := (fo.Time / 1000 / 3600) * 3600
						hours, ok := hip3Sums[dex]
						if !ok {
							hours = make(map[int64]*hip3Bucket)
							hip3Sums[dex] = hours
						}
						bk, ok := hours[fillHour]
						if !ok {
							bk = &hip3Bucket{}
							hours[fillHour] = bk
						}
						bk.feesUSD += df
						bk.volumeUSD += px * sz
						bk.fills++
					}
				}
			}

			builder := strings.ToLower(fo.Builder)
			if builder == "" || user == "" {
				continue
			}
			// byAddr is write-once at construction, safe to read unlocked.
			slug, ok := a.byAddr[builder]
			if !ok {
				continue
			}
			byDay, ok := builderDays[slug]
			if !ok {
				byDay = make(map[int64]map[string]struct{})
				builderDays[slug] = byDay
			}
			set, ok := byDay[dayKey]
			if !ok {
				set = make(map[string]struct{})
				byDay[dayKey] = set
			}
			set[user] = struct{}{}
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("scan: %w", err)
	}

	a.mu.Lock()
	for slug, byDay := range builderDays {
		for day, set := range byDay {
			for u := range set {
				a.addDailyUserLocked(slug, day*1000, u)
			}
		}
	}
	for dex, byDay := range hip3Days {
		target, ok := a.hip3DailyUsers[dex]
		if !ok {
			target = make(map[int64]map[string]struct{})
			a.hip3DailyUsers[dex] = target
		}
		for day, set := range byDay {
			tset, ok := target[day]
			if !ok {
				tset = make(map[string]struct{})
				target[day] = tset
			}
			for u := range set {
				tset[u] = struct{}{}
			}
		}
	}
	for dex, hours := range hip3Sums {
		target, ok := a.hip3Hourly[dex]
		if !ok {
			target = make(map[int64]*hip3Bucket)
			a.hip3Hourly[dex] = target
		}
		for h, bk := range hours {
			tbk, ok := target[h]
			if !ok {
				tbk = &hip3Bucket{}
				target[h] = tbk
			}
			tbk.feesUSD += bk.feesUSD
			tbk.volumeUSD += bk.volumeUSD
			tbk.fills += bk.fills
		}
	}
	a.mu.Unlock()
	return nil
}
