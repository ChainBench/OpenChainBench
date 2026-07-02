package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	installLogCapture()
	cfg := loadConfig()
	cfg.printSummary()

	// Prom :2112 in its own goroutine — Railway $PORT is deliberately ignored
	// so the shared Prometheus scraper always finds the listener.
	go func() {
		fmt.Println("[NFT] starting metrics server on :2112 (/metrics, /health, /logs)")
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("[NFT] metrics server crashed: %v\n", err)
			os.Exit(1)
		}
	}()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Initial pass at startup so Prom has data within the first 6h window.
	go runCheckAllProviders(cfg)

	if cfg.Smoke {
		// Smoke runs a single cycle then idles — Railway/local invocations
		// can just SIGINT once done. We still keep the metrics server alive
		// so /metrics can be scraped post-cycle.
		fmt.Println("[NFT] --smoke set: running ONE cycle then waiting for SIGINT")
		<-sigChan
		fmt.Println("[NFT] shutdown")
		return
	}

	ticker := time.NewTicker(time.Duration(cfg.RefreshInterval) * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-sigChan:
			fmt.Println("[NFT] shutdown")
			return
		case <-ticker.C:
			go runCheckAllProviders(cfg)
		}
	}
}
