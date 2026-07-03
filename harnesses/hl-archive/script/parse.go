// parse.go — CDN fetch + LZ4 decompress + streaming CSV decode.
//
// The HL CDN serves one .csv.lz4 file per (builder, day). This file
// owns the network I/O and the row decoder; aggregation lives in
// agg.go so the parser stays focused and unit-testable against a
// httptest server with a tiny LZ4-encoded CSV fixture.
//
// Networking choices:
//   - default to net/http with a 60s per-request timeout
//   - exponential backoff on 5xx (max 5 attempts: 1s,2s,4s,8s,16s,32s)
//   - 404 returned as ErrNotFound so the caller records a zero-row day
//   - corrupt LZ4 -> dead-letter the day to ${DB}.failures.jsonl
//
// Streaming: lz4.Reader wraps the response Body, then csv.Reader
// streams rows so we never hold a full day's fills in RAM.
package script

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pierrec/lz4/v4"
)

const cdnURLTemplate = "https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/%s/%s.csv.lz4"

// ErrNotFound = CDN 404 (builder had no fills that day).
var ErrNotFound = errors.New("cdn: not found")

// Fill mirrors one row of the CSV after type coercion. Only the
// columns we actually aggregate on are typed; the rest stay raw to
// avoid wasted decode cost.
type Fill struct {
	Time       int64
	User       string
	Coin       string
	Px         float64
	Sz         float64
	BuilderFee float64
}

// HTTPClient is overridable from tests.
var HTTPClient = &http.Client{Timeout: 60 * time.Second}

// FetchDay downloads + decompresses the file for (builder, day) and
// streams rows into the supplied callback. Returns the number of rows
// emitted or ErrNotFound if the CDN replied 404.
func FetchDay(ctx context.Context, builder string, day time.Time, fn func(Fill) error) (int, error) {
	url := fmt.Sprintf(cdnURLTemplate, strings.ToLower(builder), day.UTC().Format("20060102"))
	body, err := getWithBackoff(ctx, url)
	if err != nil {
		return 0, err
	}
	defer body.Close()

	zr := lz4.NewReader(body)
	cr := csv.NewReader(zr)
	cr.ReuseRecord = true
	cr.FieldsPerRecord = -1

	header, err := cr.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return 0, nil
		}
		return 0, fmt.Errorf("read header: %w", err)
	}
	idx, err := indexColumns(header)
	if err != nil {
		return 0, err
	}

	count := 0
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return count, fmt.Errorf("read row %d: %w", count, err)
		}
		f, perr := parseRow(rec, idx)
		if perr != nil {
			Log.Debug("skip bad row", "builder", builder, "day", day.Format("2006-01-02"), "err", perr)
			continue
		}
		if err := fn(f); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}

type colIndex struct {
	time, user, coin, px, sz, builderFee int
}

func indexColumns(header []string) (colIndex, error) {
	idx := colIndex{time: -1, user: -1, coin: -1, px: -1, sz: -1, builderFee: -1}
	for i, h := range header {
		switch strings.TrimSpace(strings.ToLower(h)) {
		case "time":
			idx.time = i
		case "user":
			idx.user = i
		case "coin":
			idx.coin = i
		case "px":
			idx.px = i
		case "sz":
			idx.sz = i
		case "builder_fee":
			idx.builderFee = i
		}
	}
	if idx.user < 0 || idx.coin < 0 || idx.px < 0 || idx.sz < 0 || idx.builderFee < 0 {
		return idx, fmt.Errorf("csv header missing required columns: got %v", header)
	}
	return idx, nil
}

func parseRow(rec []string, idx colIndex) (Fill, error) {
	if len(rec) <= idx.builderFee {
		return Fill{}, fmt.Errorf("short row (%d cols)", len(rec))
	}
	px, err := strconv.ParseFloat(strings.TrimSpace(rec[idx.px]), 64)
	if err != nil {
		return Fill{}, fmt.Errorf("px: %w", err)
	}
	sz, err := strconv.ParseFloat(strings.TrimSpace(rec[idx.sz]), 64)
	if err != nil {
		return Fill{}, fmt.Errorf("sz: %w", err)
	}
	fee, err := strconv.ParseFloat(strings.TrimSpace(rec[idx.builderFee]), 64)
	if err != nil {
		fee = 0 // tolerate blank fee columns
	}
	var ts int64
	if idx.time >= 0 {
		ts, _ = strconv.ParseInt(strings.TrimSpace(rec[idx.time]), 10, 64)
	}
	return Fill{
		Time:       ts,
		User:       strings.TrimSpace(rec[idx.user]),
		Coin:       strings.TrimSpace(rec[idx.coin]),
		Px:         px,
		Sz:         sz,
		BuilderFee: fee,
	}, nil
}

func getWithBackoff(ctx context.Context, url string) (io.ReadCloser, error) {
	const maxAttempts = 6 // 1+5 retries = 1s,2s,4s,8s,16s,32s
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			delay := time.Duration(1<<(attempt-1)) * time.Second
			jitter := time.Duration(rand.Int63n(int64(delay) / 4))
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay + jitter):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "hl-archive/1.0 (+ocb)")
		resp, err := HTTPClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		switch {
		case resp.StatusCode == http.StatusNotFound,
			resp.StatusCode == http.StatusForbidden:
			// 404 = builder/day combination not in the CDN's index.
			// 403 = same in practice for this bucket: CloudFront serves
			// 403 (not 404) for objects that never existed under that
			// prefix, e.g. a builder that had zero fills that day or
			// did not yet exist on chain. Treat as "no data" — record
			// a zero-row processed day, do not retry, do not error.
			resp.Body.Close()
			return nil, ErrNotFound
		case resp.StatusCode >= 500:
			resp.Body.Close()
			lastErr = fmt.Errorf("cdn %d", resp.StatusCode)
			continue
		case resp.StatusCode >= 400:
			resp.Body.Close()
			return nil, fmt.Errorf("cdn %d", resp.StatusCode)
		default:
			return resp.Body, nil
		}
	}
	return nil, fmt.Errorf("cdn unavailable after retries: %w", lastErr)
}

// DeadLetter appends a JSON line describing an unrecoverable parse
// failure (e.g. corrupt LZ4). The caller is expected to skip the day
// and continue; an operator can grep the file to backfill manually.
func DeadLetter(dbPath, builder, day, reason string) {
	path := dbPath + ".failures.jsonl"
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		Log.Error("dead-letter open failed", "path", path, "err", err)
		return
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	_ = enc.Encode(map[string]string{
		"ts":      time.Now().UTC().Format(time.RFC3339),
		"builder": builder,
		"day":     day,
		"reason":  reason,
	})
}
