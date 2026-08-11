package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const minTradeUSD = 5.0

func main() {
	log.Println("memecoin-platforms monitor starting...")

	apiKey := os.Getenv("MOBULA_API_KEY")
	if apiKey == "" {
		log.Fatal("MOBULA_API_KEY is required")
	}

	mobulaClient := &http.Client{Timeout: 30 * time.Second}
	rpcClient := &http.Client{Timeout: 10 * time.Second}

	setSolPrice(175.0)
	updateSolPrice(mobulaClient)

	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			updateSolPrice(mobulaClient)
		}
	}()

	runPoll(mobulaClient, rpcClient, apiKey)

	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			runPoll(mobulaClient, rpcClient, apiKey)
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
	totalFeeSum   float64
	tradeValueSum float64
	n             int
}

func runPoll(mobulaClient, rpcClient *http.Client, apiKey string) {
	tokens, err := fetchTopTokens(mobulaClient, 10)
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

		trades, err := fetchTrades(mobulaClient, apiKey, tok.Mint)
		if err != nil {
			log.Printf("[mobula][%s] %v", tok.Symbol, err)
			pollErrors.WithLabelValues("mobula").Inc()
			time.Sleep(500 * time.Millisecond)
			continue
		}

		byPlatform := make(map[string]*platformStats)
		for _, t := range trades {
			if t.AmountUSD < minTradeUSD {
				continue
			}
			p := t.Platform
			if p == "" {
				p = "pump-fun"
			}
			s := byPlatform[p]
			if s == nil {
				s = &platformStats{}
				byPlatform[p] = s
			}
			feeUSD := computeExplicitFees(rpcClient, t.Hash, t.Sender)
			s.totalFeeSum += feeUSD
			s.tradeValueSum += t.AmountUSD
			s.n++
		}

		sym := tok.Symbol
		if sym == "" {
			sym = tok.Mint[:8]
		}

		for p, s := range byPlatform {
			n := float64(s.n)
			avgTotal := s.totalFeeSum / n
			avgVal := s.tradeValueSum / n
			feePct := 0.0
			if avgVal > 0 {
				feePct = (avgTotal / avgVal) * 100
			}
			platformFeePct.WithLabelValues(p, sym, tok.Mint).Set(feePct)
			platformTotalFeeUSD.WithLabelValues(p, sym, tok.Mint).Set(avgTotal)
			platformTradeCount.WithLabelValues(p, sym, tok.Mint).Set(n)
		}

		log.Printf("[mobula][%s] %d trades across %d platforms", sym, len(trades), len(byPlatform))
		time.Sleep(500 * time.Millisecond)
	}

	lastPollTime.SetToCurrentTime()
}
