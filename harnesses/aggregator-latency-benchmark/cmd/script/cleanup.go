package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// setupCleanupEndpoint adds an admin endpoint for selective data cleanup
func setupCleanupEndpoint(mux *http.ServeMux) {
	adminToken := os.Getenv("ADMIN_CLEANUP_TOKEN")
	if adminToken == "" {
		log.Println("[CLEANUP] Warning: ADMIN_CLEANUP_TOKEN not set - cleanup endpoint will be disabled")
		return
	}

	mux.HandleFunc("/admin/cleanup", func(w http.ResponseWriter, r *http.Request) {
		// Only allow DELETE method
		if r.Method != "DELETE" {
			http.Error(w, "Method not allowed - use DELETE", http.StatusMethodNotAllowed)
			return
		}

		// Check authorization
		authHeader := r.Header.Get("Authorization")
		expectedAuth := "Bearer " + adminToken
		if authHeader != expectedAuth {
			log.Printf("[CLEANUP] Unauthorized cleanup attempt from %s", r.RemoteAddr)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		// Parse the 'before' timestamp parameter
		beforeStr := r.URL.Query().Get("before")
		if beforeStr == "" {
			http.Error(w, "Missing 'before' parameter (use RFC3339 format: 2026-04-10T00:00:00Z)", http.StatusBadRequest)
			return
		}

		before, err := time.Parse(time.RFC3339, beforeStr)
		if err != nil {
			http.Error(w, fmt.Sprintf("Invalid timestamp format: %v (use RFC3339: 2026-04-10T00:00:00Z)", err), http.StatusBadRequest)
			return
		}

		// Get data paths from environment or use defaults
		prometheusPath := os.Getenv("PROMETHEUS_DATA_PATH")
		if prometheusPath == "" {
			prometheusPath = "/data/prometheus"
		}

		grafanaPath := os.Getenv("GRAFANA_DATA_PATH")
		if grafanaPath == "" {
			grafanaPath = "/data/grafana"
		}

		log.Printf("[CLEANUP] Starting cleanup: deleting data before %s", before.Format(time.RFC3339))
		log.Printf("[CLEANUP] Prometheus path: %s", prometheusPath)
		log.Printf("[CLEANUP] Grafana path: %s", grafanaPath)

		totalDeleted := 0

		// Cleanup Prometheus data
		if _, err := os.Stat(prometheusPath); err == nil {
			deleted, err := cleanupDirectory(prometheusPath, before)
			if err != nil {
				log.Printf("[CLEANUP] Error cleaning Prometheus data: %v", err)
				http.Error(w, fmt.Sprintf("Prometheus cleanup failed: %v", err), http.StatusInternalServerError)
				return
			}
			totalDeleted += deleted
			log.Printf("[CLEANUP] Deleted %d items from Prometheus", deleted)
		} else {
			log.Printf("[CLEANUP] Prometheus path not found: %s", prometheusPath)
		}

		// Cleanup Grafana data
		if _, err := os.Stat(grafanaPath); err == nil {
			deleted, err := cleanupDirectory(grafanaPath, before)
			if err != nil {
				log.Printf("[CLEANUP] Error cleaning Grafana data: %v", err)
				http.Error(w, fmt.Sprintf("Grafana cleanup failed: %v", err), http.StatusInternalServerError)
				return
			}
			totalDeleted += deleted
			log.Printf("[CLEANUP] Deleted %d items from Grafana", deleted)
		} else {
			log.Printf("[CLEANUP] Grafana path not found: %s", grafanaPath)
		}

		response := fmt.Sprintf("✅ Cleanup complete\n\nDeleted %d files/directories before %s\n\nPaths cleaned:\n- %s\n- %s\n",
			totalDeleted, before.Format(time.RFC3339), prometheusPath, grafanaPath)

		log.Printf("[CLEANUP] Cleanup complete: %d items deleted", totalDeleted)
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, response)
	})

	log.Printf("[CLEANUP] Admin cleanup endpoint enabled at /admin/cleanup")
}

// cleanupDirectory removes files and directories older than the specified time
func cleanupDirectory(dir string, before time.Time) (int, error) {
	deleted := 0

	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, fmt.Errorf("failed to read directory: %w", err)
	}

	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		info, err := entry.Info()
		if err != nil {
			log.Printf("[CLEANUP] Warning: failed to get info for %s: %v", path, err)
			continue
		}

		// Check if modification time is before the cutoff
		if info.ModTime().Before(before) {
			log.Printf("[CLEANUP] Deleting: %s (modified: %s)", path, info.ModTime().Format(time.RFC3339))

			if err := os.RemoveAll(path); err != nil {
				log.Printf("[CLEANUP] Warning: failed to delete %s: %v", path, err)
				continue
			}

			deleted++
		}
	}

	return deleted, nil
}
