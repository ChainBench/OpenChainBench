package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Package-level Betfair session state. Managed by initBetfairAuth.
// betfairRequestMutator() reads from these; pinBetfair reads from these.
var (
	betfairMu       sync.RWMutex
	betfairToken    string
	betfairAppKey__ string
)

// initBetfairAuth starts the background goroutine that keeps the Betfair
// session token alive. Call once at startup when credentials are present.
func initBetfairAuth(cfg Config) {
	betfairMu.Lock()
	betfairAppKey__ = cfg.BetfairAppKey
	if cfg.BetfairSessionToken != "" {
		betfairToken = cfg.BetfairSessionToken
	}
	betfairMu.Unlock()

	if cfg.BetfairSessionToken != "" {
		// Pre-supplied token: keepalive only
		go betfairKeepaliveLoop(cfg)
		return
	}
	if cfg.BetfairUsername != "" && cfg.BetfairPassword != "" {
		go betfairLoginLoop(cfg)
	}
}

func betfairLoginLoop(cfg Config) {
	for {
		token, err := betfairLogin(cfg.BetfairUsername, cfg.BetfairPassword, cfg.BetfairAppKey)
		if err != nil {
			log.Printf("[betfair-auth] login failed: %v (retry in 60s)", err)
			time.Sleep(60 * time.Second)
			continue
		}
		betfairMu.Lock()
		betfairToken = token
		betfairMu.Unlock()
		log.Printf("[betfair-auth] session token refreshed")
		time.Sleep(20 * time.Hour) // tokens valid 24h; refresh after 20h
	}
}

func betfairKeepaliveLoop(cfg Config) {
	t := time.NewTicker(15 * time.Minute)
	defer t.Stop()
	for range t.C {
		if err := betfairKeepalive(cfg.BetfairAppKey); err != nil {
			log.Printf("[betfair-auth] keepalive failed: %v", err)
			if cfg.BetfairUsername != "" && cfg.BetfairPassword != "" {
				if token, err2 := betfairLogin(cfg.BetfairUsername, cfg.BetfairPassword, cfg.BetfairAppKey); err2 == nil {
					betfairMu.Lock()
					betfairToken = token
					betfairMu.Unlock()
					log.Printf("[betfair-auth] re-logged in after keepalive failure")
				}
			}
		}
	}
}

func betfairLogin(username, password, appKey string) (string, error) {
	data := url.Values{}
	data.Set("username", username)
	data.Set("password", password)

	req, err := http.NewRequest(http.MethodPost,
		"https://identitysso.betfair.com/api/login",
		strings.NewReader(data.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("X-Application", appKey)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		Token  string `json:"token"`
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}
	if result.Status != "SUCCESS" {
		return "", fmt.Errorf("status=%q error=%q", result.Status, result.Error)
	}
	return result.Token, nil
}

func betfairKeepalive(appKey string) error {
	betfairMu.RLock()
	token := betfairToken
	betfairMu.RUnlock()

	req, err := http.NewRequest(http.MethodGet,
		"https://identitysso.betfair.com/api/keepAlive", nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Application", appKey)
	req.Header.Set("X-Authentication", token)
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var result struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	if result.Status != "SUCCESS" {
		return fmt.Errorf("keepalive status=%q", result.Status)
	}
	return nil
}

// betfairRequestMutator returns a function that stamps the current Betfair
// AppKey and session token onto outgoing requests.
func betfairRequestMutator() func(*http.Request) {
	return func(req *http.Request) {
		betfairMu.RLock()
		appKey := betfairAppKey__
		token := betfairToken
		betfairMu.RUnlock()
		if appKey != "" {
			req.Header.Set("X-Application", appKey)
		}
		if token != "" {
			req.Header.Set("X-Authentication", token)
		}
	}
}
