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
// for one builder address, aggregates the 24h window, updates every
// Prom metric for that builder, AND upserts each fill into the
// SQLite state so the retention pass later in the cycle sees fresh
// data. Returns the 24h notional so the caller can compute the
// cross-builder volume share.
//
// The "last 24h" is computed by trimming both CSVs at `now - 24h`
// so the rollover at UTC midnight doesn't double-count or drop fills.
func processBuilder(ctx context.Context, b Builder, state *State) float64 {
	now := time.Now().UTC()
	cutoff := now.Add(-24 * time.Hour)

	dates := []time.Time{now.AddDate(0, 0, -1), now}
	var fills []fillRow
	for _, d := range dates {
		batch, code, err := fetchDay(ctx, b.Address, d)
		hlCSVFetchStatus.WithLabelValues(b.Slug, code).Inc()
		if err != nil {
			fmt.Printf("[%s] %s: %s err=%v\n", b.Slug, d.Format("20060102"), code, err)
			continue
		}
		fills = append(fills, batch...)
	}

	var (
		notionalUSD   float64
		builderFeeUSD float64
		fillCount     int
		users         = make(map[string]struct{})
	)
	for _, f := range fills {
		notional := f.Px * f.Sz
		// State always gets every fill (full builder history), not
		// just the 24h window — retention math needs the long tail.
		if state != nil && f.User != "" {
			if err := state.Upsert(b.Slug, f.User, f.Time.UnixMilli(), notional); err != nil {
				fmt.Printf("[%s] state upsert error: %v\n", b.Slug, err)
			}
		}
		// 24h windowed aggregates for the live gauges.
		if f.Time.Before(cutoff) {
			continue
		}
		notionalUSD += notional
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

	fmt.Printf("[%s] fills=%d notional=$%.0f fees=$%.2f users=%d eff=%.2fbps\n",
		b.Slug, fillCount, notionalUSD, builderFeeUSD, len(users),
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
