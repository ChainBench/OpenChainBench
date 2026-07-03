// logger.go — slog JSON logger initialisation.
//
// Single package-level *slog.Logger configured from LOG_LEVEL.
// All other files use Log.* directly so logs stay structured and
// trivially shippable to BetterStack/Loki without per-call setup.
package script

import (
	"log/slog"
	"os"
	"strings"
	"sync"
)

var (
	Log     *slog.Logger
	loggerOnce sync.Once
)

func initLogger() {
	loggerOnce.Do(func() {
		level := slog.LevelInfo
		switch strings.ToLower(strings.TrimSpace(os.Getenv("LOG_LEVEL"))) {
		case "debug":
			level = slog.LevelDebug
		case "warn", "warning":
			level = slog.LevelWarn
		case "error":
			level = slog.LevelError
		}
		Log = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
		slog.SetDefault(Log)
	})
}
