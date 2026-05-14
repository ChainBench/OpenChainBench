#!/bin/bash
# Clean Prometheus data older than 1 day

PROMETHEUS_URL="https://prometheus-production-0859.up.railway.app"

# Calculate timestamp for 1 day ago (in milliseconds)
ONE_DAY_AGO=$(($(date +%s) - 86400))
ONE_DAY_AGO_MS=$((ONE_DAY_AGO * 1000))

echo "Deleting Prometheus data older than $(date -r $ONE_DAY_AGO)"
echo "Keeping data from: $(date -r $ONE_DAY_AGO) to now"

# Delete all series older than 1 day
curl -X POST \
  "${PROMETHEUS_URL}/api/v1/admin/tsdb/delete_series" \
  -d 'match[]={__name__=~".+"}' \
  -d "start=0" \
  -d "end=${ONE_DAY_AGO_MS}"

echo ""
echo "Triggering cleanup (this removes tombstones)..."

# Trigger cleanup to reclaim disk space
curl -X POST "${PROMETHEUS_URL}/api/v1/admin/tsdb/clean_tombstones"

echo ""
echo "Done! Prometheus now only retains last 1 day of data."
