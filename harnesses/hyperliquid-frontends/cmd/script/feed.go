package main

import (
	"bufio"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/pierrec/lz4/v4"
)

// The Hyperliquid team publishes one CSV per (builder address, UTC day) on a
// public, keyless CDN. Day D lands during the early hours of D+1 (observed
// 02:45 to 03:30 UTC). A missing file answers 403, which is also what a
// builder with no fills that day gets, so "not published yet" and "no
// fills" are told apart at cohort level (see availability.go).
const feedURLTemplate = "https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/%s/%s.csv.lz4"

const dayFormat = "20060102"

var feedHTTP = &http.Client{Timeout: 120 * time.Second}

var errFeedAbsent = errors.New("feed: no file for that builder and day")

// Mirror keeps a local copy of every fetched CSV under
// <root>/builder_fills/<address>/<YYYYMMDD>.csv.lz4, plus a
// <YYYYMMDD>.absent marker (containing the unix time of the check) when the
// CDN answered 403. Restarts re-read the mirror instead of the CDN.
type Mirror struct {
	root string
}

func newMirror(root string) (*Mirror, error) {
	if err := os.MkdirAll(filepath.Join(root, "builder_fills"), 0o755); err != nil {
		return nil, err
	}
	return &Mirror{root: root}, nil
}

func (m *Mirror) filePath(addr string, day time.Time) string {
	return filepath.Join(m.root, "builder_fills", strings.ToLower(addr), day.UTC().Format(dayFormat)+".csv.lz4")
}

func (m *Mirror) absentPath(addr string, day time.Time) string {
	return filepath.Join(m.root, "builder_fills", strings.ToLower(addr), day.UTC().Format(dayFormat)+".absent")
}

// present reports whether the CSV for (addr, day) is on disk.
func (m *Mirror) present(addr string, day time.Time) bool {
	st, err := os.Stat(m.filePath(addr, day))
	return err == nil && st.Size() > 0
}

// absentSince returns the time of the last 403 recorded for (addr, day),
// or the zero time when no marker exists.
func (m *Mirror) absentSince(addr string, day time.Time) time.Time {
	raw, err := os.ReadFile(m.absentPath(addr, day))
	if err != nil {
		return time.Time{}
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(n, 0).UTC()
}

func (m *Mirror) markAbsent(addr string, day time.Time) error {
	p := m.absentPath(addr, day)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(strconv.FormatInt(time.Now().Unix(), 10)), 0o644)
}

// prune deletes files and markers older than keepDays.
func (m *Mirror) prune(keepDays int) {
	cutoff := time.Now().UTC().AddDate(0, 0, -keepDays).Format(dayFormat)
	dirs, err := os.ReadDir(filepath.Join(m.root, "builder_fills"))
	if err != nil {
		return
	}
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(m.root, "builder_fills", d.Name()))
		if err != nil {
			continue
		}
		for _, f := range files {
			name := f.Name()
			if len(name) < len(dayFormat) {
				continue
			}
			if name[:len(dayFormat)] < cutoff {
				_ = os.Remove(filepath.Join(m.root, "builder_fills", d.Name(), name))
			}
		}
	}
}

// fetch downloads the CSV for (addr, day) into the mirror. Returns
// errFeedAbsent on 403/404 (marker written), a transport or 5xx error after
// retries, nil on success.
func (m *Mirror) fetch(ctx context.Context, addr string, day time.Time) error {
	url := fmt.Sprintf(feedURLTemplate, strings.ToLower(addr), day.UTC().Format(dayFormat))
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			delay := time.Duration(1<<(attempt-1))*2*time.Second + time.Duration(rand.Int63n(int64(time.Second)))
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "openchainbench-hl-frontends/2 (+https://openchainbench.com)")
		resp, err := feedHTTP.Do(req)
		if err != nil {
			lastErr = err
			feedFetchTotal.WithLabelValues("error").Inc()
			continue
		}
		switch {
		case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound:
			resp.Body.Close()
			feedFetchTotal.WithLabelValues("absent").Inc()
			if err := m.markAbsent(addr, day); err != nil {
				return err
			}
			return errFeedAbsent
		case resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests:
			resp.Body.Close()
			lastErr = fmt.Errorf("feed: http %d", resp.StatusCode)
			feedFetchTotal.WithLabelValues("retry").Inc()
			continue
		case resp.StatusCode != http.StatusOK:
			resp.Body.Close()
			feedFetchTotal.WithLabelValues("error").Inc()
			return fmt.Errorf("feed: http %d", resp.StatusCode)
		}
		p := m.filePath(addr, day)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			resp.Body.Close()
			return err
		}
		tmp := p + ".tmp"
		f, err := os.Create(tmp)
		if err != nil {
			resp.Body.Close()
			return err
		}
		_, copyErr := io.Copy(f, resp.Body)
		resp.Body.Close()
		closeErr := f.Close()
		if copyErr != nil || closeErr != nil {
			_ = os.Remove(tmp)
			lastErr = fmt.Errorf("feed: download: %v %v", copyErr, closeErr)
			feedFetchTotal.WithLabelValues("retry").Inc()
			continue
		}
		if err := os.Rename(tmp, p); err != nil {
			return err
		}
		// Stamp the file with the CDN's Last-Modified (the batch upload
		// time) so the settle check in chooseDataDay measures how long the
		// batch has been on the CDN, not how long ago we downloaded it. A
		// cold start over old days is then eligible at once.
		if lm, err := http.ParseTime(resp.Header.Get("Last-Modified")); err == nil && !lm.IsZero() {
			_ = os.Chtimes(p, lm, lm)
		}
		_ = os.Remove(m.absentPath(addr, day))
		feedFetchTotal.WithLabelValues("ok").Inc()
		return nil
	}
	return lastErr
}

// userAgg is one wallet's totals inside a daySummary.
type userAgg struct {
	vol   float64
	pnl   float64
	fee   float64
	fills int
}

// daySummary is everything the publisher needs from one (address, day)
// CSV. Wallets are keyed by lowercased address; the whole cohort runs to a
// few hundred thousand (wallet, day) pairs over the window, which fits.
type daySummary struct {
	fees      float64
	vol       float64
	fills     int
	taker     int
	users     map[string]userAgg
	coinVol   map[string]float64
	lastFillS int64
}

func newDaySummary() *daySummary {
	return &daySummary{users: make(map[string]userAgg), coinVol: make(map[string]float64)}
}

// parseFile reads one mirrored CSV into a daySummary.
func (m *Mirror) parseFile(addr string, day time.Time) (*daySummary, error) {
	f, err := os.Open(m.filePath(addr, day))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parseFills(bufio.NewReaderSize(lz4.NewReader(f), 1<<20))
}

// parseFills folds a decompressed builder_fills CSV into a daySummary.
// Columns (2026-09): time,user,coin,side,px,sz,crossed,special_trade_type,
// tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee. Only time,
// user, coin, px, sz and builder_fee are required; crossed and closed_pnl
// are optional and feed the taker share and the profitable-user share.
func parseFills(r io.Reader) (*daySummary, error) {
	cr := csv.NewReader(r)
	cr.ReuseRecord = true
	cr.FieldsPerRecord = -1
	header, err := cr.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return newDaySummary(), nil
		}
		return nil, fmt.Errorf("header: %w", err)
	}
	col := map[string]int{}
	for i, h := range header {
		col[strings.TrimSpace(strings.ToLower(h))] = i
	}
	for _, req := range []string{"time", "user", "coin", "px", "sz", "builder_fee"} {
		if _, ok := col[req]; !ok {
			return nil, fmt.Errorf("missing column %q in %v", req, header)
		}
	}
	iTime, iUser, iCoin, iPx, iSz, iFee := col["time"], col["user"], col["coin"], col["px"], col["sz"], col["builder_fee"]
	iCrossed, hasCrossed := col["crossed"]
	iPnl, hasPnl := col["closed_pnl"]

	s := newDaySummary()
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return s, fmt.Errorf("row %d: %w", s.fills, err)
		}
		if len(rec) <= iFee || len(rec) <= iSz || len(rec) <= iPx {
			continue
		}
		px, err1 := strconv.ParseFloat(strings.TrimSpace(rec[iPx]), 64)
		sz, err2 := strconv.ParseFloat(strings.TrimSpace(rec[iSz]), 64)
		if err1 != nil || err2 != nil {
			continue
		}
		fee, _ := strconv.ParseFloat(strings.TrimSpace(rec[iFee]), 64)
		notional := px * sz
		s.fills++
		s.vol += notional
		s.fees += fee
		if hasCrossed && iCrossed < len(rec) && strings.EqualFold(strings.TrimSpace(rec[iCrossed]), "true") {
			s.taker++
		}
		if coin := strings.TrimSpace(rec[iCoin]); coin != "" {
			s.coinVol[coin] += notional
		}
		if ts := parseFillTime(rec[iTime]); ts > s.lastFillS {
			s.lastFillS = ts
		}
		if user := strings.ToLower(strings.TrimSpace(rec[iUser])); user != "" {
			ua := s.users[user]
			ua.vol += notional
			ua.fee += fee
			ua.fills++
			if hasPnl && iPnl < len(rec) {
				if pnl, err := strconv.ParseFloat(strings.TrimSpace(rec[iPnl]), 64); err == nil {
					ua.pnl += pnl
				}
			}
			s.users[user] = ua
		}
	}
	return s, nil
}

// parseFillTime accepts the two shapes the feed has shipped: RFC3339 and
// unix milliseconds. Returns unix seconds, 0 when unparseable.
func parseFillTime(raw string) int64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	if ms, err := strconv.ParseInt(raw, 10, 64); err == nil {
		if ms > 1e12 {
			return ms / 1000
		}
		return ms
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t.Unix()
	}
	return 0
}
