package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	log.Println("memecoin-platforms monitor starting...")

	apiKey := os.Getenv("MOBULA_API_KEY")
	if apiKey == "" {
		log.Fatal("MOBULA_API_KEY is required")
	}

	interval := 5 * time.Minute
	client := &http.Client{Timeout: 30 * time.Second}

	// First poll immediately, then tick.
	runPoll(client, apiKey)

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			runPoll(client, apiKey)
		}
	}()

	http.Handle("/metrics", promhttp.Handler())
	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})
	log.Println("serving metrics on :9090")
	log.Fatal(http.ListenAndServe(":9090", nil))
}

type platformStats struct {
	platformFeeSum float64
	gasSum         float64
	totalFeeSum    float64
	tradeValueSum  float64
	n              int
}

func runPoll(client *http.Client, apiKey string) {
	tokens, err := fetchTopTokens(client, 10)
	if err != nil {
		log.Printf("[pump.fun] %v", err)
		pollErrors.WithLabelValues("pumpfun").Inc()
		return
	}
	log.Printf("[pump.fun] %d tokens", len(tokens))

	for _, tok := range tokens {
		if tok.Mint == "" {
			continue
		}

		trades, err := fetchTrades(client, apiKey, tok.Mint)
		if err != nil {
			log.Printf("[mobula][%s] %v", tok.Symbol, err)
			pollErrors.WithLabelValues("mobula").Inc()
			// pace between tokens even on error
			time.Sleep(500 * time.Millisecond)
			continue
		}

		byPlatform := make(map[string]*platformStats)
		for _, t := range trades {
			p := t.Platform
			if p == "" {
				p = "unknown"
			}
			s := byPlatform[p]
			if s == nil {
				s = &platformStats{}
				byPlatform[p] = s
			}
			s.platformFeeSum += t.PlatformFeesUSD
			s.gasSum += t.GasFeesUSD
			s.totalFeeSum += t.TotalFeesUSD
			s.tradeValueSum += t.AmountUSD
			s.n++
		}

		sym := tok.Symbol
		if sym == "" {
			sym = tok.Mint[:8]
		}

		for p, s := range byPlatform {
			n := float64(s.n)
			avgPlatformFee := s.platformFeeSum / n
			avgGas := s.gasSum / n
			avgTotal := s.totalFeeSum / n
			avgVal := s.tradeValueSum / n

			feePct := 0.0
			if avgVal > 0 {
				feePct = (avgTotal / avgVal) * 100
			}

			platformFeePct.WithLabelValues(p, sym, tok.Mint).Set(feePct)
			platformFeeUSD.WithLabelValues(p, sym, tok.Mint).Set(avgPlatformFee)
			platformGasUSD.WithLabelValues(p, sym, tok.Mint).Set(avgGas)
			platformTotalFeeUSD.WithLabelValues(p, sym, tok.Mint).Set(avgTotal)
			platformTradeCount.WithLabelValues(p, sym, tok.Mint).Set(n)
		}

		log.Printf("[mobula][%s] %d trades across %d platforms", sym, len(trades), len(byPlatform))
		time.Sleep(500 * time.Millisecond)
	}

	lastPollTime.SetToCurrentTime()
}
