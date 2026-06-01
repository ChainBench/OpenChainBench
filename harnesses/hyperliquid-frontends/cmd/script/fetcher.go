package main

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pierrec/lz4/v4"
)

// processBuilder fetches today's + yesterday's Hyperliquid fills CSV
// for one builder address, aggregates the last complete UTC day,
// updates every Prom metric for that builder, AND upserts each fill
// into the SQLite state so the retention pass later in the cycle
// sees fresh data. Returns the day notional so the caller can
// compute the cross-builder volume share.
//
// The headline window is `yesterday's complete UTC day` (i.e. the
// CSV for date T-1). We switched from rolling-24h because the
// rolling cutoff was unfairly zeroing builders whose flow lands
// early in the UTC day — at 18:00 UTC the cutoff `now - 24h` is
// 18:00 yesterday, so a builder that traded between 00:00-17:00
// yesterday would show 0. The UTC-day window gives every builder
// the same comparison surface at the cost of 0-24h of staleness,
// which is fine for a fee-quality bench (frontends don't change
// pricing minute-to-minute). Today's CSV is still fetched so the
// SQLite state captures the in-progress day for retention math.
func processBuilder(ctx context.Context, b Builder, state *State) float64 {
	now := time.Now().UTC()

	// Hyperliquid publishes the per-day CSV with a variable delay —
	// usually T-1 lands within hours of UTC midnight, but the bucket
	// has gone 48 h+ without a fresh file (observed 2026-05-31). To
	// avoid zeroing every builder on a publish lag, walk back up to
	// 3 days and pick the most recent date that returned a non-empty
	// CSV. State always upserts from whatever days we did fetch so
	// retention math gets the freshest signal regardless.
	dates := []time.Time{
		now.AddDate(0, 0, -1),
		now.AddDate(0, 0, -2),
		now.AddDate(0, 0, -3),
	}
	var headlineFills []fillRow
	var headlineDateKey string
	for _, d := range dates {
		batch, code, err := fetchDay(ctx, b.Address, d)
		hlCSVFetchStatus.WithLabelValues(b.Slug, code).Inc()
		if err != nil {
			fmt.Printf("[%s] %s: %s err=%v\n", b.Slug, d.Format("20060102"), code, err)
			continue
		}
		// State always gets every fill — retention math wants the
		// long history of unique users, not just the headline day.
		for _, f := range batch {
			if state != nil && f.User != "" {
				if err := state.Upsert(b.Slug, f.User, f.Time.UnixMilli(), f.Px*f.Sz); err != nil {
					fmt.Printf("[%s] state upsert error: %v\n", b.Slug, err)
				}
			}
		}
		// Pick the first day that has at least one fill — that's
		// the freshest "complete UTC day" for this builder.
		if headlineDateKey == "" && len(batch) > 0 {
			headlineFills = batch
			headlineDateKey = d.Format("20060102")
		}
	}

	var (
		notionalUSD   float64
		builderFeeUSD float64
		fillCount     int
		users         = make(map[string]struct{})
	)
	for _, f := range headlineFills {
		notionalUSD += f.Px * f.Sz
		builderFeeUSD += f.BuilderFee
		fillCount++
		if f.User != "" {
			users[f.User] = struct{}{}
		}
	}

	hlFillsTotal.WithLabelValues(b.Slug).Set(float64(fillCount))
	hlVolumeUSD24h.WithLabelValues(b.Slug).Set(notionalUSD)
	hlUsers24h.WithLabelValues(b.Slug).Set(float64(len(users)))

	if notionalUSD > 0 {
		hlEffectiveFeeBps.WithLabelValues(b.Slug).Set(builderFeeUSD / notionalUSD * 10_000)
	}
	if len(users) > 0 {
		hlFeesPerUserUSD.WithLabelValues(b.Slug).Set(builderFeeUSD / float64(len(users)))
	}

	fmt.Printf("[%s] day=%s fills=%d notional=$%.0f fees=$%.2f users=%d eff=%.2fbps\n",
		b.Slug, headlineDateKey, fillCount, notionalUSD, builderFeeUSD, len(users),
		safeRatio(builderFeeUSD, notionalUSD)*10_000)
	return notionalUSD
}

type fillRow struct {
	Time       time.Time
	User       string
	Coin       string
	Side       string
	Px         float64
	Sz         float64
	BuilderFee float64
}

// fetchDay GETs the per-day CSV dump, LZ4-decompresses, parses into
// fillRow slices. Returns (rows, http_code_label, err). The
// http_code_label is the string we want to label the
// `hl_frontend_csv_fetch_status_total` counter with — "200" for OK,
// "403" for "no fills that day" (Hyperliquid bucket returns 403 when
// the date file doesn't exist), "5xx" for server errors, "error" for
// transport-level failures.
func fetchDay(ctx context.Context, address string, day time.Time) ([]fillRow, string, error) {
	url := fmt.Sprintf(
		"https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/%s/%s.csv.lz4",
		strings.ToLower(address),
		day.Format("20060102"),
	)
	reqCtx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "error", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "error", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode >= 500 {
			return nil, "5xx", fmt.Errorf("http %d", resp.StatusCode)
		}
		return nil, fmt.Sprintf("%d", resp.StatusCode), nil
	}

	dec := lz4.NewReader(resp.Body)
	rd := csv.NewReader(dec)
	rd.FieldsPerRecord = -1
	header, err := rd.Read()
	if err != nil {
		return nil, "200", fmt.Errorf("header: %w", err)
	}
	col := map[string]int{}
	for i, h := range header {
		col[strings.TrimSpace(h)] = i
	}
	required := []string{"time", "user", "px", "sz", "builder_fee"}
	for _, r := range required {
		if _, ok := col[r]; !ok {
			return nil, "200", fmt.Errorf("missing column %q in header %v", r, header)
		}
	}

	var rows []fillRow
	for {
		rec, err := rd.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return rows, "200", fmt.Errorf("row: %w", err)
		}
		if len(rec) < len(header) {
			continue
		}
		t, err := parseFillTime(rec[col["time"]])
		if err != nil {
			continue
		}
		px, _ := strconv.ParseFloat(rec[col["px"]], 64)
		sz, _ := strconv.ParseFloat(rec[col["sz"]], 64)
		fee, _ := strconv.ParseFloat(rec[col["builder_fee"]], 64)
		rows = append(rows, fillRow{
			Time:       t,
			User:       strings.ToLower(rec[col["user"]]),
			Coin:       safeCol(rec, col, "coin"),
			Side:       safeCol(rec, col, "side"),
			Px:         px,
			Sz:         sz,
			BuilderFee: fee,
		})
	}
	return rows, "200", nil
}

func safeCol(rec []string, col map[string]int, k string) string {
	i, ok := col[k]
	if !ok || i >= len(rec) {
		return ""
	}
	return rec[i]
}

// parseFillTime accepts the two timestamp shapes Hyperliquid has
// shipped over the lifetime of the bucket: Unix-millis integers and
// RFC3339 strings. Both have been observed in the wild.
func parseFillTime(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, fmt.Errorf("empty time")
	}
	if ms, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return time.UnixMilli(ms).UTC(), nil
	}
	return time.Parse(time.RFC3339Nano, raw)
}

func safeRatio(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b
}
