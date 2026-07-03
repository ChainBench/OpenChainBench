#!/bin/sh

echo "=== GRAFANA ENTRYPOINT SCRIPT STARTING ==="
echo "Working directory: $(pwd)"
echo "User: $(whoami)"

# Create dashboards directory
mkdir -p /var/lib/grafana/dashboards

# Debug: print environment variables
echo "Checking environment..."
env | grep -E '(RAILWAY|HIDE_QUOTE)' || echo "No RAILWAY/HIDE_QUOTE variables found"

# Copy dashboards from source
if [ "$HIDE_QUOTE_DASHBOARD" = "true" ]; then
  echo "HIDE_QUOTE_DASHBOARD=true - hiding Quote API Latency Benchmark dashboard"
  cp /dashboards-source/head_lag.json /var/lib/grafana/dashboards/
else
  echo "Copying all dashboards"
  cp /dashboards-source/*.json /var/lib/grafana/dashboards/
fi

echo "Dashboards copied:"
ls -la /var/lib/grafana/dashboards/

echo "=== GRAFANA ENTRYPOINT SCRIPT COMPLETE ==="

# Start Grafana with default entrypoint
exec /run.sh
