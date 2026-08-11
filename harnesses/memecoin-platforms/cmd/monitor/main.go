package main

import (
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const minTradeUSD = 5.0

var pollMu sync.Mutex

func main() {
	log.Println("memecoin-platforms monitor starting...")

	apiKey := os.Getenv("MOBULA_API_KEY")
	if apiKey == "" {
		log.Fatal("MOBULA_API_KEY is required")
	}

	heliusKey := os.Getenv("HELIUS_API_KEY")

	mobulaClient := &http.Client{
		Timeout:   30 * time.Second,
		Transport: &http.Transport{Proxy: nil},
	}

	// rpcClient routes through rotating proxy to avoid per-IP rate limits
	var rpcClient *http.Client
	if proxyRaw := os.Getenv("HTTPS_PROXY"); proxyRaw != "" {
		if proxyURL, err := url.Parse(proxyRaw); err == nil {
			rpcClient = &http.Client{
				Timeout:   30 * time.Second,
				Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)},
			}
			log.Printf("rpc: rotating proxy enabled")
		}
	}
	if rpcClient == nil {
		rpcClient = &http.Client{Timeout: 30 * time.Second}
	}

	// heliusClient used as fallback for older tx not in public RPC history
	heliusClient := &http.Client{Timeout: 30 * time.Second}

	setSolPrice(76.0)
	updateSolPrice(mobulaClient)

	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			updateSolPrice(mobulaClient)
		}
	}()

	go func() {
		http.Handle("/metrics", promhttp.Handler())
		http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
		})
		log.Println("serving metrics on :9090")
		log.Fatal(http.ListenAndServe(":9090", nil))
	}()

	runPoll(mobulaClient, rpcClient, heliusClient, heliusKey, apiKey)

	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		if !pollMu.TryLock() {
			log.Println("[poll] previous poll still running, skipping tick")
			continue
		}
		go func() {
			defer pollMu.Unlock()
			runPoll(mobulaClient, rpcClient, heliusClient, heliusKey, apiKey)
		}()
	}
}

type platformStats struct {
	totalFeeSum   float64
	tradeValueSum float64
	n             int
}

func runPoll(mobulaClient, rpcClient, heliusClient *http.Client, heliusKey, apiKey string) {
	tokens, err := fetchTopTokens(mobulaClient, 25)
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
		freshLookups := 0
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
			_, cached := txCache.Load(t.Hash)
			if !cached && freshLookups >= 40 {
				s.tradeValueSum += t.AmountUSD
				s.n++
				continue
			}
			if !cached {
				freshLookups++
			}
			feeUSD := computeExplicitFees(rpcClient, heliusClient, heliusKey, t.Hash, t.Sender)
			s.totalFeeSum += feeUSD
			s.tradeValueSum += t.AmountUSD
			s.n++
		}

		sym := strings.TrimSpace(tok.Symbol)
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
			platformFeePct.WithLabelValues(p, sym).Set(feePct)
			platformTotalFeeUSD.WithLabelValues(p, sym).Set(avgTotal)
			platformTradeCount.WithLabelValues(p, sym).Set(n)
		}

		log.Printf("[mobula][%s] %d trades across %d platforms", sym, len(trades), len(byPlatform))
		time.Sleep(500 * time.Millisecond)
	}

	lastPollTime.SetToCurrentTime()
}
