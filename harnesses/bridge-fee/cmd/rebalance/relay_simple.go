package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type RelayQuoteReq struct {
	User                string `json:"user"`
	OriginChainID       int64  `json:"originChainId"`
	DestinationChainID  int64  `json:"destinationChainId"`
	OriginCurrency      string `json:"originCurrency"`
	DestinationCurrency string `json:"destinationCurrency"`
	Amount              string `json:"amount"`
	TradeType           string `json:"tradeType"`
	Recipient           string `json:"recipient"`
}

type RelayQuoteResp struct {
	Details struct {
		CurrencyIn  struct{ AmountUsd string `json:"amountUsd"` } `json:"currencyIn"`
		CurrencyOut struct{ AmountUsd string `json:"amountUsd"` } `json:"currencyOut"`
	} `json:"details"`
	Steps []struct {
		ID        string `json:"id"`
		RequestId string `json:"requestId"`
		Items     []struct {
			Data struct {
				To    string `json:"to"`
				Data  string `json:"data"`
				Value string `json:"value"`
			} `json:"data"`
			Check struct {
				Endpoint string `json:"endpoint"`
			} `json:"check"`
		} `json:"items"`
	} `json:"steps"`
}

type RelayStatus struct {
	Status string `json:"status"`
	Details string `json:"details"`
}

func relayQuote(req RelayQuoteReq) (*RelayQuoteResp, error) {
	body, _ := json.Marshal(req)
	httpReq, _ := http.NewRequest("POST", "https://api.relay.link/quote", bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 45 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("relay %d: %s", resp.StatusCode, string(raw))
	}
	var out RelayQuoteResp
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func relayPollStatus(checkURL string, timeout time.Duration) (*RelayStatus, error) {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 10 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(checkURL)
		if err != nil {
			time.Sleep(5 * time.Second)
			continue
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var s RelayStatus
		if err := json.Unmarshal(raw, &s); err == nil {
			fmt.Printf("  Status: %s\n", s.Status)
			if strings.EqualFold(s.Status, "success") || strings.EqualFold(s.Status, "filled") ||
				strings.EqualFold(s.Status, "settled") || strings.EqualFold(s.Status, "refund") ||
				strings.EqualFold(s.Status, "failure") {
				return &s, nil
			}
		}
		time.Sleep(5 * time.Second)
	}
	return nil, fmt.Errorf("timeout polling Relay status")
}
