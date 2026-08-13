package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const lighthouseURL = "https://api.mobula.io/api/2/market/lighthouse"

type lighthouseClient struct {
	apiKey string
	http   *http.Client
}

func newLighthouseClient(apiKey string) *lighthouseClient {
	return &lighthouseClient{
		apiKey: apiKey,
		http:   &http.Client{Timeout: 15 * time.Second},
	}
}

// fetchVolumes returns platform name -> volume_usd_24h from the Mobula lighthouse.
func (c *lighthouseClient) fetchVolumes() (map[string]float64, error) {
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

	type entry struct {
		Name      string `json:"name"`
		VolumeUSD struct {
			H24 float64 `json:"24h"`
		} `json:"volumeUSD"`
	}
	var out struct {
		Data struct {
			ByPlatform []entry `json:"byPlatform"`
			ByLaunchpad []entry `json:"byLaunchpad"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}

	volumes := make(map[string]float64)
	for _, p := range out.Data.ByPlatform {
		if p.Name == "" {
			continue
		}
		volumes[strings.ToLower(p.Name)] = p.VolumeUSD.H24
	}
	// pump.fun bonding curve is under byLaunchpad as "PumpFun"
	for _, p := range out.Data.ByLaunchpad {
		key := strings.ToLower(p.Name)
		if key == "pumpfun" {
			volumes["pump-fun"] = p.VolumeUSD.H24
		}
	}
	return volumes, nil
}
