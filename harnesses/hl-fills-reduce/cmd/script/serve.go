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
		f, err := os.Open(r.servePathFor(day))
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
			fmt.Fprintf(w, `{"day":%q,"hours":%d,"complete":%t,"rebuilt":%t}`,
				d.Day, d.Hours, d.Complete, d.Rebuilt)
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

// servePathFor is which file /daily/<day> hands over, and it must follow the
// same rule availableDays lists by: a WHOLE measured day wins, a partial
// measured day loses to a rebuilt whole one, and with no rebuilt day the
// partial measurement is still the best there is.
//
// Shared rather than duplicated on purpose. The first version inlined this in
// the handler and opened the reduced file whenever it existed, so a day the
// listing announced as a rebuilt whole day was served as the partial
// measurement: the consumer would have summed 11 hours believing it held 24,
// which is the exact class of quiet wrong answer this harness exists to stop.
func (r *Reducer) servePathFor(day string) string {
	reducedPath := r.outPath(day)
	if r.RebuiltDir == "" {
		return reducedPath
	}
	if d, err := r.LoadDay(day); err == nil && d.Complete {
		return reducedPath
	}
	cand := filepath.Join(r.RebuiltDir, day+".json.gz")
	if d, err := r.loadFrom(cand); err == nil && d.Rebuilt {
		return cand
	}
	return reducedPath
}

type dayInfo struct {
	Day      string
	Hours    int
	Complete bool
	// Rebuilt marks a day assembled from the public export and the per-wallet
	// info API rather than measured by the node. Consumers must be able to
	// tell the two apart: the figures are close (-0.43% on the 2026-10-09
	// validation) but they are a reconstruction, and a reconstruction that
	// reads as a measurement is the failure this harness was written against.
	Rebuilt bool
}

// availableDays lists the reduced days, then fills the gaps with rebuilt ones.
//
// A measured day always wins. A rebuilt day is offered only where the node has
// no whole day, so restoring the node never silently keeps a reconstruction in
// service, and a rebuilt day never displaces a real one.
func (r *Reducer) availableDays() []dayInfo {
	out := make([]dayInfo, 0, 64)
	whole := map[string]bool{}

	if ents, err := os.ReadDir(r.OutDir); err == nil {
		for _, e := range ents {
			n := e.Name()
			if !strings.HasSuffix(n, ".json.gz") {
				continue
			}
			d, err := r.LoadDay(strings.TrimSuffix(n, ".json.gz"))
			if err != nil {
				continue
			}
			out = append(out, dayInfo{Day: d.Day, Hours: d.Hours, Complete: d.Complete})
			if d.Complete {
				whole[d.Day] = true
			}
		}
	}

	if r.RebuiltDir != "" {
		if ents, err := os.ReadDir(r.RebuiltDir); err == nil {
			for _, e := range ents {
				n := e.Name()
				if !strings.HasSuffix(n, ".json.gz") {
					continue
				}
				day := strings.TrimSuffix(n, ".json.gz")
				if whole[day] {
					continue // the node measured this one; keep the measurement
				}
				d, err := r.loadFrom(filepath.Join(r.RebuiltDir, n))
				if err != nil || !d.Rebuilt {
					continue // unflagged files in this directory are not trusted
				}
				// Replace the partial reduced entry for the same day, if any.
				replaced := false
				for i := range out {
					if out[i].Day == day {
						out[i] = dayInfo{Day: day, Hours: d.Hours, Complete: d.Complete, Rebuilt: true}
						replaced = true
						break
					}
				}
				if !replaced {
					out = append(out, dayInfo{Day: day, Hours: d.Hours, Complete: d.Complete, Rebuilt: true})
				}
			}
		}
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Day < out[j].Day })
	return out
}

func (r *Reducer) writeMetrics(w http.ResponseWriter) {
	days := r.availableDays()
	whole, partial, rebuilt := 0, 0, 0
	newest := ""
	for _, d := range days {
		if d.Complete {
			whole++
		} else {
			partial++
		}
		if d.Rebuilt {
			rebuilt++
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

	// The root filesystem, separately. A healthy data volume says nothing
	// about the one holding the binaries, the journal and /tmp, and that is
	// the one that took this node down for three days in October 2026.
	// -1 when unreadable, so "not measured" cannot be read as "empty".
	rootFree, rootTotal := r.rootSpace()
	rootUsedPct := -1.0
	if rootTotal > 0 {
		rootUsedPct = float64(rootTotal-rootFree) / float64(rootTotal) * 100
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
# HELP hl_reduce_rebuilt_days_total Days served from the rebuild directory rather than measured by the node. Assembled from the public export plus the per-wallet info API, and close but not measurements: the 2026-10-09 validation came out 0.43 per cent under the node. A window leaning on these is a window to say so about. Note for editors: a literal percent sign here is a format verb to Go and silently eats the next argument.
# TYPE hl_reduce_rebuilt_days_total gauge
hl_reduce_rebuilt_days_total %d
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
# HELP hl_reduce_root_disk_used_pct Used space on the root filesystem, which holds the node binaries, the journal and /tmp. A full root stops the node while the data volume still looks healthy. -1 when unreadable.
# TYPE hl_reduce_root_disk_used_pct gauge
hl_reduce_root_disk_used_pct %.1f
# HELP hl_reduce_root_disk_free_bytes Free space on the root filesystem.
# TYPE hl_reduce_root_disk_free_bytes gauge
hl_reduce_root_disk_free_bytes %d
# HELP hl_reduce_last_scrape_unix Unix time this endpoint was last read.
# TYPE hl_reduce_last_scrape_unix gauge
hl_reduce_last_scrape_unix %d
`, whole, partial, rebuilt, newestAge, lastHourAge, usedPct, free, rootUsedPct, rootFree, time.Now().Unix())
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
