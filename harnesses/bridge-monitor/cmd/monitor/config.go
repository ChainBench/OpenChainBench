package main

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// API Keys
	RelayAPIKey       string
	MobulaAPIKey      string
	DebridgeAPIKey    string
	LiFiAPIKey        string
	NearIntentsAPIKey string
	SquidIntegratorID string
	SocketAPIKey      string

	// Wallet Configuration
	WalletEVMPrivateKey string
	WalletEVMAddress    string
	WalletSOLPrivateKey string
	WalletSOLAddress    string

	// Execution Configuration
	ExecutionMode     string        // "dry-run", "single-test", "production"
	Freq3USD          time.Duration // Frequency for $3 tests
	Freq30USD         time.Duration // Frequency for $30 tests
	EnableDebridge    bool          // Execute Debridge (expensive)
	EnableR4RoundTrip bool          // Execute R4 TRUMP<->BRETT round-trip (memes, not fee-neutral)
	EnableR5Hypercore bool          // Execute R5 Arb<->HyperCore round-trip (needs HL withdraw path)
	MaxDailySpendUSD  float64       // Safety cap
	TestAmountUSD     float64       // Override test amount (for testing with small amounts)

	// General
	MonitorRegion    string
	SimulateBalances bool

	// Notifications
	SlackWebhookURL string
}

// parseDuration parses a duration string, returns default if invalid
func parseDuration(s string, defaultVal time.Duration) time.Duration {
	if s == "" {
		return defaultVal
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return defaultVal
	}
	return d
}

// mobulaAPIBase returns the Mobula REST base URL (no trailing slash). Defaults
// to the production host; override with MOBULA_API_BASE. We moved off
// demo-api.mobula.io to the production api.mobula.io endpoint.
func mobulaAPIBase() string {
	if v := strings.TrimSpace(os.Getenv("MOBULA_API_BASE")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "https://api.mobula.io"
}

// parseFloat parses a float string, returns default if invalid
func parseFloat(s string, defaultVal float64) float64 {
	if s == "" {
		return defaultVal
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return defaultVal
	}
	return f
}

func loadEnv() (*Config, error) {
	config := &Config{}

	// Load from environment variables first (for production/Railway)
	config.RelayAPIKey = strings.TrimSpace(os.Getenv("RELAY_API_KEY"))
	config.MobulaAPIKey = strings.TrimSpace(os.Getenv("MOBULA_API_KEY"))
	config.DebridgeAPIKey = strings.TrimSpace(os.Getenv("DEBRIDGE_API_KEY"))
	config.LiFiAPIKey = strings.TrimSpace(os.Getenv("LIFI_API_KEY"))
	config.NearIntentsAPIKey = strings.TrimSpace(os.Getenv("NEARINTENTS_API_KEY"))
	config.SquidIntegratorID = strings.TrimSpace(os.Getenv("SQUID_INTEGRATOR_ID"))
	config.SocketAPIKey = strings.TrimSpace(os.Getenv("SOCKET_API_KEY"))

	// Wallet configuration
	config.WalletEVMPrivateKey = strings.TrimSpace(os.Getenv("WALLET_EVM_PRIVATE_KEY"))
	config.WalletEVMAddress = strings.TrimSpace(os.Getenv("WALLET_EVM_ADDRESS"))
	config.WalletSOLPrivateKey = strings.TrimSpace(os.Getenv("WALLET_SOL_PRIVATE_KEY"))
	config.WalletSOLAddress = strings.TrimSpace(os.Getenv("WALLET_SOL_ADDRESS"))

	// Execution configuration
	config.ExecutionMode = strings.TrimSpace(os.Getenv("EXECUTION_MODE"))
	if config.ExecutionMode == "" {
		config.ExecutionMode = "dry-run" // Safe default
	}

	// Frequencies (default: $3 daily, $30 2x/week)
	config.Freq3USD = parseDuration(os.Getenv("FREQ_3_USD"), 24*time.Hour)
	config.Freq30USD = parseDuration(os.Getenv("FREQ_30_USD"), 84*time.Hour) // ~3.5 days

	// Debridge execution (default: disabled, too expensive)
	config.EnableDebridge = os.Getenv("ENABLE_DEBRIDGE_EXEC") == "true"

	// R4 (TRUMP<->BRETT) and R5 (Arb<->HyperCore) round-trip execution are
	// opt-in: both move value across non-stable or asymmetric legs, so they
	// stay quote-only until deliberately enabled and validated in single-test.
	config.EnableR4RoundTrip = os.Getenv("ENABLE_R4_ROUNDTRIP_EXEC") == "true"
	config.EnableR5Hypercore = os.Getenv("ENABLE_R5_HYPERCORE_EXEC") == "true"

	// Max daily spend (default: $10/day for safety)
	config.MaxDailySpendUSD = parseFloat(os.Getenv("MAX_DAILY_SPEND_USD"), 10.0)

	// Test amount override (0 = use default amounts)
	config.TestAmountUSD = parseFloat(os.Getenv("TEST_AMOUNT_USD"), 0)

	// General
	config.MonitorRegion = strings.TrimSpace(os.Getenv("MONITOR_REGION"))
	if config.MonitorRegion == "" {
		config.MonitorRegion = "unknown"
	}

	config.SimulateBalances = os.Getenv("SIMULATE_BALANCES") == "true"

	// Slack notifications
	config.SlackWebhookURL = strings.TrimSpace(os.Getenv("SLACK_WEBHOOK_URL"))

	// Also try .env file for any missing values (local development)
	file, err := os.Open(".env")
	if err != nil {
		// No .env file is OK - services will just be skipped
		return config, nil
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key, value := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		switch key {
		case "RELAY_API_KEY":
			if config.RelayAPIKey == "" {
				config.RelayAPIKey = value
			}
		case "MOBULA_API_KEY":
			if config.MobulaAPIKey == "" {
				config.MobulaAPIKey = value
			}
		case "DEBRIDGE_API_KEY":
			if config.DebridgeAPIKey == "" {
				config.DebridgeAPIKey = value
			}
		case "LIFI_API_KEY":
			if config.LiFiAPIKey == "" {
				config.LiFiAPIKey = value
			}
		case "NEARINTENTS_API_KEY":
			if config.NearIntentsAPIKey == "" {
				config.NearIntentsAPIKey = value
			}
		case "WALLET_EVM_PRIVATE_KEY":
			if config.WalletEVMPrivateKey == "" {
				config.WalletEVMPrivateKey = value
			}
		case "WALLET_EVM_ADDRESS":
			if config.WalletEVMAddress == "" {
				config.WalletEVMAddress = value
			}
		case "WALLET_SOL_PRIVATE_KEY":
			if config.WalletSOLPrivateKey == "" {
				config.WalletSOLPrivateKey = value
			}
		case "WALLET_SOL_ADDRESS":
			if config.WalletSOLAddress == "" {
				config.WalletSOLAddress = value
			}
		case "MONITOR_REGION":
			if config.MonitorRegion == "" || config.MonitorRegion == "unknown" {
				config.MonitorRegion = value
			}
		case "EXECUTION_MODE":
			if config.ExecutionMode == "" || config.ExecutionMode == "dry-run" {
				config.ExecutionMode = value
			}
		case "SLACK_WEBHOOK_URL":
			if config.SlackWebhookURL == "" {
				config.SlackWebhookURL = value
			}
		case "MAX_DAILY_SPEND_USD":
			if config.MaxDailySpendUSD == 10.0 { // default value
				config.MaxDailySpendUSD = parseFloat(value, 10.0)
			}
		case "TEST_AMOUNT_USD":
			if config.TestAmountUSD == 0 {
				config.TestAmountUSD = parseFloat(value, 0)
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading .env file: %w", err)
	}

	return config, nil
}

// LogConfig prints the configuration (without sensitive data)
func (c *Config) LogConfig() {
	log.Println("⚙️  Configuration:")
	log.Printf("  Mobula API Key: %s", maskKey(c.MobulaAPIKey))
	log.Printf("  Relay API Key: %s", maskKey(c.RelayAPIKey))
	log.Printf("  Li.Fi API Key: %s", maskKey(c.LiFiAPIKey))
	log.Printf("  Debridge API Key: %s", maskKey(c.DebridgeAPIKey))
	log.Printf("  EVM Address: %s", c.WalletEVMAddress)
	log.Printf("  Solana Address: %s", c.WalletSOLAddress)
	log.Printf("  EVM Private Key: %s", maskKey(c.WalletEVMPrivateKey))
	log.Printf("  Solana Private Key: %s", maskKey(c.WalletSOLPrivateKey))
	log.Printf("  Execution Mode: %s", c.ExecutionMode)
	log.Printf("  $3 Frequency: %v", c.Freq3USD)
	log.Printf("  $30 Frequency: %v", c.Freq30USD)
	log.Printf("  Debridge Execution: %v", c.EnableDebridge)
	log.Printf("  R4 Round-trip Execution: %v", c.EnableR4RoundTrip)
	log.Printf("  R5 HyperCore Execution: %v", c.EnableR5Hypercore)
	log.Printf("  Max Daily Spend: $%.2f", c.MaxDailySpendUSD)
	if c.TestAmountUSD > 0 {
		log.Printf("  Test Amount Override: $%.2f", c.TestAmountUSD)
	}
	log.Printf("  Region: %s", c.MonitorRegion)
	log.Printf("  Slack Notifications: %s", boolToEnabled(c.SlackWebhookURL != ""))
}

func boolToEnabled(b bool) string {
	if b {
		return "enabled"
	}
	return "disabled"
}

// maskKey masks a key for logging (shows first 4 and last 4 chars)
func maskKey(key string) string {
	if key == "" {
		return "(not set)"
	}
	if len(key) <= 8 {
		return "****"
	}
	return key[:4] + "..." + key[len(key)-4:]
}
