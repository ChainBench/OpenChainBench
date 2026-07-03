# ============================================================================
# Aggregator Latency Monitor with Grafana Dashboard
# ============================================================================

BINARY_NAME = latency_monitor
BINARY_PATH = bin/monitor
GO_FILES = ./cmd/script

.PHONY: help
help:
	@echo "Aggregator Latency Monitor - Grafana Dashboard"
	@echo "=============================================="
	@echo ""
	@echo "Commands:"
	@echo "  make run      - Start everything (Grafana + All monitors in background)"
	@echo "  make pulse    - Start Mobula Pulse monitor only (foreground)"
	@echo "  make stop     - Stop all services"
	@echo "  make logs     - Follow monitor logs"
	@echo "  make status   - Show status of all services"
	@echo "  make build    - Build Go binary"
	@echo "  make clean    - Stop services and remove binaries/logs"
	@echo "  make destroy  - Remove everything including volumes (asks confirmation)"
	@echo ""
	@echo "Dashboard Access:"
	@echo "  Grafana:    http://localhost:3000 (admin/admin)"
	@echo "  Prometheus: http://localhost:9090"
	@echo "  Metrics:    http://localhost:2112/metrics"
	@echo ""

.PHONY: deps
deps:
	@echo "📦 Downloading dependencies..."
	@go mod tidy
	@go mod download
	@echo "✓ Dependencies ready"
	@echo ""

.PHONY: build
build: deps
	@echo "🔨 Building $(BINARY_NAME)..."
	@mkdir -p bin
	@go build -o $(BINARY_PATH) $(GO_FILES)
	@echo "✓ Build complete: $(BINARY_PATH)"
	@echo ""

.PHONY: start-grafana
start-grafana:
	@echo "📊 Starting Grafana + Prometheus stack..."
	@docker-compose up -d
	@echo "✓ Grafana stack running"
	@echo "  → Grafana:    http://localhost:3000 (admin/admin)"
	@echo "  → Prometheus: http://localhost:9090"
	@echo ""

.PHONY: run
run: build start-grafana
	@echo "🚀 Starting Aggregator Latency Monitors in background..."
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "  → Starting monitors (CoinGecko, Mobula Pulse, Mobula Trade, Codex)..."
	@./$(BINARY_PATH) > monitor.log 2>&1 & echo $$! > monitor.pid
	@sleep 2
	@if [ -f monitor.pid ]; then \
		echo "  ✓ Monitors started (PID: $$(cat monitor.pid))"; \
	else \
		echo "  ❌ Failed to start monitors"; \
	fi
	@echo ""
	@echo "✓ All monitors running"
	@echo "✓ Monitoring: CoinGecko, Mobula (Pulse + Trade), Codex"
	@echo "✓ Chains: Solana, BNB, Base, Monad"
	@echo "✓ Metrics: http://localhost:2112/metrics"
	@echo "✓ Logs: make logs"
	@echo "✓ Stop: make stop"
	@echo ""

.PHONY: down
down:
	@echo "🛑 Stopping services..."
	@if [ -f monitor.pid ]; then \
		echo "  → Stopping monitors (PID: $$(cat monitor.pid))..."; \
		kill $$(cat monitor.pid) 2>/dev/null || true; \
		rm -f monitor.pid; \
	fi
	@echo "  → Killing all monitor processes..."
	@pkill -9 -f "bin/monitor" 2>/dev/null || true
	@echo "  → Stopping Docker containers..."
	@docker-compose down 2>/dev/null || true
	@docker stop prometheus grafana 2>/dev/null || true
	@docker rm prometheus grafana 2>/dev/null || true
	@echo "✓ All services stopped (volumes preserved)"

.PHONY: stop
stop: down

.PHONY: clean
clean: down
	@echo "🧹 Cleaning binaries and logs..."
	@rm -f $(BINARY_PATH) $(BINARY_NAME) monitor.log
	@echo "✓ Clean complete"

.PHONY: logs
logs:
	@if [ -f monitor.log ]; then \
		tail -f monitor.log; \
	else \
		echo "❌ No log file found. Is the monitor running?"; \
		echo "   Run 'make run' first"; \
	fi

.PHONY: status
status:
	@echo "📊 Service Status:"
	@echo ""
	@if [ -f monitor.pid ] && kill -0 $$(cat monitor.pid) 2>/dev/null; then \
		echo "  ✓ Monitors:        Running (PID: $$(cat monitor.pid))"; \
	else \
		echo "  ✗ Monitors:        Stopped"; \
	fi
	@if docker-compose ps | grep -q "Up"; then \
		echo "  ✓ Grafana:         Running (http://localhost:3000)"; \
		echo "  ✓ Prometheus:      Running (http://localhost:9090)"; \
	else \
		echo "  ✗ Grafana:         Stopped"; \
		echo "  ✗ Prometheus:      Stopped"; \
	fi
	@echo ""

.PHONY: destroy
destroy:
	@echo "⚠️  WARNING: This will remove all containers, volumes, and binaries!"
	@echo "⚠️  All Grafana dashboards and Prometheus data will be lost!"
	@echo ""
	@read -p "Are you sure? [y/N] " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		echo "🗑️  Destroying everything..."; \
		if [ -f monitor.pid ]; then kill $$(cat monitor.pid) 2>/dev/null || true; rm -f monitor.pid; fi; \
		pkill -9 -f "bin/monitor" 2>/dev/null || true; \
		docker-compose down -v 2>/dev/null || true; \
		rm -f $(BINARY_PATH) $(BINARY_NAME) monitor.log monitor.pid; \
		echo "✓ Everything destroyed"; \
	else \
		echo "❌ Cancelled"; \
	fi

.PHONY: pulse
pulse:
	@echo "🚀 Starting Mobula Pulse V2 Monitor..."
	@go run ./cmd/pulse/*.go

.DEFAULT_GOAL := help
