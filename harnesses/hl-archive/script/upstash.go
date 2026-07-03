// upstash.go — REST push to Upstash Redis (no Redis client needed).
//
// Upstash exposes a plain HTTPS endpoint (SET key value) that we hit
// via net/http. Keeping the surface tiny means we don't pull in
// go-redis and its transitive deps for a single SET per day.
package script

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// UpstashPayload is the shape the OCB consumer (Next.js page) reads.
type UpstashPayload struct {
	UpdatedAt string                    `json:"updated_at"`
	Builders  map[string]UpstashBuilder `json:"builders"`
}

type UpstashBuilder struct {
	Name            string                  `json:"name"`
	Windows         map[string]WindowAgg    `json:"windows"`
	TimeseriesDaily []TimePoint             `json:"timeseries_daily"`
}

// upstashTimeseriesDaysCap is the hard cap on per-builder daily points
// pushed to Upstash. Sized so the worst case (≈110 builders × 90 days
// × ~60 B/row ≈ 600 KB) stays well under the 1 MB Vercel KV free-tier
// ceiling. Window aggregates (24h..all) keep full coverage because
// they're constant-size per builder.
const upstashTimeseriesDaysCap = 90

// PushUpstash sends the payload to the configured Upstash key. No-op
// (returns nil) when UPSTASH_REDIS_REST_URL/TOKEN are unset so local
// dev runs don't fail.
func PushUpstash(ctx context.Context, payload UpstashPayload) error {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("UPSTASH_REDIS_REST_URL")), "/")
	token := strings.TrimSpace(os.Getenv("UPSTASH_REDIS_REST_TOKEN"))
	if base == "" || token == "" {
		Log.Warn("upstash disabled (env not set)")
		return nil
	}
	key := strings.TrimSpace(os.Getenv("HL_ARCHIVE_UPSTASH_KEY"))
	if key == "" {
		key = "ocb:hl-archive:v1"
	}

	// Cap per-builder daily series before serialising. QueryDailyTimeseriesAllBuilders
	// orders rows ASC, so the most recent N live at the tail.
	for addr, b := range payload.Builders {
		if n := len(b.TimeseriesDaily); n > upstashTimeseriesDaysCap {
			b.TimeseriesDaily = b.TimeseriesDaily[n-upstashTimeseriesDaysCap:]
			payload.Builders[addr] = b
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	endpoint := fmt.Sprintf("%s/set/%s", base, url.PathEscape(key))
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	MetricUpstashPushDur.Observe(time.Since(start).Seconds())
	if err != nil {
		return fmt.Errorf("upstash post: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("upstash %d: %s", resp.StatusCode, string(b))
	}
	Log.Info("upstash push ok", "key", key, "bytes", len(body))
	return nil
}
