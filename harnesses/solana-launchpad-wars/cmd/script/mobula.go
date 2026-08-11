package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const lighthouseURL = "https://api.mobula.io/api/2/market/lighthouse"

type mobulaClient struct {
	apiKey string
	http   *http.Client
}

func newMobulaClient(apiKey string) *mobulaClient {
	return &mobulaClient{
		apiKey: apiKey,
		http:   &http.Client{Timeout: 15 * time.Second},
	}
}

type windowValues struct {
	Min15 float64 `json:"15min"`
	H1    float64 `json:"1h"`
	H6    float64 `json:"6h"`
	H24   float64 `json:"24h"`
}

type lighthouseEntry struct {
	Name        string       `json:"name"`
	VolumeUSD   windowValues `json:"volumeUSD"`
	FeesPaidUSD windowValues `json:"feesPaidUSD"`
	Trades      windowValues `json:"trades"`
}

type lighthouseData struct {
	ByLaunchpad []lighthouseEntry `json:"byLaunchpad"`
	ByPlatform  []lighthouseEntry `json:"byPlatform"`
}

func (c *mobulaClient) fetchLighthouse() (*lighthouseData, error) {
	req, err := http.NewRequest(http.MethodGet, lighthouseURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build req: %w", err)
	}
	req.Header.Set("Authorization", c.apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("status %d: %.200s", resp.StatusCode, body)
	}

	var out struct {
		Data lighthouseData `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	return &out.Data, nil
}
