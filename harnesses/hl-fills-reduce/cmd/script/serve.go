package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// serve exposes the reduced days and the health of the box they come from.
//
// The health half is not incidental. On 2026-10-07 this machine ran 15 hours
// with its cleanup job failing every 15 minutes and its disk climbing from
// 80% to 86%, roughly a day and a half from full, and nothing noticed because
// no Prometheus scraped it. The data this serves is only as good as the node
// that writes it, so the two travel together.
func serve(addr string, r *Reducer) error {
	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "ok")
	})

	// /daily/<YYYYMMDD> returns the reduced day, gzipped on the wire exactly
	// as it sits on disk.
	mux.HandleFunc("/daily/", func(w http.ResponseWriter, req *http.Request) {
		day := strings.TrimPrefix(req.URL.Path, "/daily/")
		if len(day) != 8 || strings.ContainsAny(day, "/.") {
			http.Error(w, "bad day", http.StatusBadRequest)
			return
		}
		f, err := os.Open(r.outPath(day))
		if err != nil {
			http.Error(w, "not reduced", http.StatusNotFound)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		http.ServeContent(w, req, day+".json", time.Time{}, f)
	})

	// /days lists what is available, so the consumer can ask once instead of
	// probing a month of 404s.
	mux.HandleFunc("/days", func(w http.ResponseWriter, _ *http.Request) {
		days := r.availableDays()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, "[")
		for i, d := range days {
			if i > 0 {
				fmt.Fprint(w, ",")
			}
			fmt.Fprintf(w, `{"day":%q,"hours":%d,"complete":%t}`, d.Day, d.Hours, d.Complete)
		}
		fmt.Fprint(w, "]")
	})

	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		r.writeMetrics(w)
	})

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return srv.ListenAndServe()
}

type dayInfo struct {
	Day      string
	Hours    int
	Complete bool
}

func (r *Reducer) availableDays() []dayInfo {
	ents, err := os.ReadDir(r.OutDir)
	if err != nil {
		return nil
	}
	var out []dayInfo
	for _, e := range ents {
		n := e.Name()
		if !strings.HasSuffix(n, ".json.gz") {
			continue
		}
		day := strings.TrimSuffix(n, ".json.gz")
		d, err := r.LoadDay(day)
		if err != nil {
			continue
		}
		out = append(out, dayInfo{Day: d.Day, Hours: d.Hours, Complete: d.Complete})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Day < out[j].Day })
	return out
}

func (r *Reducer) writeMetrics(w http.ResponseWriter) {
	days := r.availableDays()
	whole, partial := 0, 0
	newest := ""
	for _, d := range days {
		if d.Complete {
			whole++
		} else {
			partial++
		}
		if d.Day > newest {
			newest = d.Day
		}
	}

	// Freshness as an age rather than a timestamp, because the question asked
	// of it is always "how stale", and a timestamp needs the reader to know
	// what time it is on this box.
	newestAge := -1.0
	if newest != "" {
		if t, err := time.Parse("20060102", newest); err == nil {
			newestAge = time.Since(t.AddDate(0, 0, 1)).Seconds()
		}
	}

	free, total := r.freeSpace()
	usedPct := 0.0
	if total > 0 {
		usedPct = float64(total-free) / float64(total) * 100
	}

	// The node's own liveness, read from the hourly tree rather than from
	// systemd: a node that is "active" but not writing fills is the failure
	// mode that matters here, and it looks healthy to systemctl.
	lastHourAge := -1.0
	if p, t, ok := r.newestHourFile(); ok {
		_ = p
		lastHourAge = time.Since(t).Seconds()
	}

	fmt.Fprintf(w, `# HELP hl_reduce_days_total Reduced days held, by completeness.
# TYPE hl_reduce_days_total gauge
hl_reduce_days_total{complete="true"} %d
hl_reduce_days_total{complete="false"} %d
# HELP hl_reduce_newest_day_age_seconds Age of the newest reduced day, measured from the end of that UTC day. Negative when nothing is reduced.
# TYPE hl_reduce_newest_day_age_seconds gauge
hl_reduce_newest_day_age_seconds %.0f
# HELP hl_reduce_node_last_hour_age_seconds Age of the newest hourly fill file the node has written. This is the node's real liveness: it can be running and not writing.
# TYPE hl_reduce_node_last_hour_age_seconds gauge
hl_reduce_node_last_hour_age_seconds %.0f
# HELP hl_reduce_disk_used_pct Used space on the filesystem holding the node data.
# TYPE hl_reduce_disk_used_pct gauge
hl_reduce_disk_used_pct %.1f
# HELP hl_reduce_disk_free_bytes Free space on the filesystem holding the node data.
# TYPE hl_reduce_disk_free_bytes gauge
hl_reduce_disk_free_bytes %d
# HELP hl_reduce_last_scrape_unix Unix time this endpoint was last read.
# TYPE hl_reduce_last_scrape_unix gauge
hl_reduce_last_scrape_unix %d
`, whole, partial, newestAge, lastHourAge, usedPct, free, time.Now().Unix())
}

// newestHourFile finds the most recently written hourly fill file.
func (r *Reducer) newestHourFile() (string, time.Time, bool) {
	days, err := os.ReadDir(r.FillsDir)
	if err != nil || len(days) == 0 {
		return "", time.Time{}, false
	}
	sort.Slice(days, func(i, j int) bool { return days[i].Name() > days[j].Name() })
	for _, d := range days[:min(3, len(days))] {
		dir := filepath.Join(r.FillsDir, d.Name())
		hours, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		var best time.Time
		var bestPath string
		for _, h := range hours {
			fi, err := h.Info()
			if err != nil {
				continue
			}
			if fi.ModTime().After(best) {
				best = fi.ModTime()
				bestPath = filepath.Join(dir, h.Name())
			}
		}
		if bestPath != "" {
			return bestPath, best, true
		}
	}
	return "", time.Time{}, false
}
