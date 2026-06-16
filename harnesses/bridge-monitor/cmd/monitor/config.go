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
	RelayAPIKey    string
	MobulaAPIKey   string
	DebridgeAPIKey string
	LiFiAPIKey     string

	// Wallet Configuration
	WalletEVMPrivateKey string
	WalletEVMAddress    string
	WalletSOLPrivateKey string
	WalletSOLAddress    string

	// Execution Configuration
	ExecutionMode    string        // "dry-run", "single-test", "production"
	Freq5USD         time.Duration // Frequency for $5 tests
	Freq50USD        time.Duration // Frequency for $50 tests
	Freq300USD       time.Duration // Frequency for $300 tests
	EnableDebridge   bool          // Execute Debridge (expensive)
	MaxDailySpendUSD float64       // Safety cap
	TestAmountUSD    float64       // Override test amount (for testing with small amounts)

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

	// Frequencies (default: $5 daily, $50 2x/week, $300 2x/month)
	config.Freq5USD = parseDuration(os.Getenv("FREQ_5_USD"), 24*time.Hour)
	config.Freq50USD = parseDuration(os.Getenv("FREQ_50_USD"), 84*time.Hour)    // ~3.5 days
	config.Freq300USD = parseDuration(os.Getenv("FREQ_300_USD"), 168*time.Hour) // 7 days (weekly)

	// Debridge execution (default: disabled, too expensive)
	config.EnableDebridge = os.Getenv("ENABLE_DEBRIDGE_EXEC") == "true"

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
	log.Printf("  $5 Frequency: %v", c.Freq5USD)
	log.Printf("  $50 Frequency: %v", c.Freq50USD)
	log.Printf("  $300 Frequency: %v", c.Freq300USD)
	log.Printf("  Debridge Execution: %v", c.EnableDebridge)
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
