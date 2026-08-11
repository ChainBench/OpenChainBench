package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type itunesEntry struct {
	Rating      float64 `json:"averageUserRating"`
	ReviewCount int     `json:"userRatingCount"`
	TrackName   string  `json:"trackName"`
}

type itunesResp struct {
	ResultCount int           `json:"resultCount"`
	Results     []itunesEntry `json:"results"`
}

func fetchAppStoreData(appID string) (*itunesEntry, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	url := fmt.Sprintf("https://itunes.apple.com/lookup?id=%s&country=us", appID)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "OpenChainBench/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d", resp.StatusCode)
	}

	var data itunesResp
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	if data.ResultCount == 0 || len(data.Results) == 0 {
		return nil, fmt.Errorf("no_results")
	}
	return &data.Results[0], nil
}
