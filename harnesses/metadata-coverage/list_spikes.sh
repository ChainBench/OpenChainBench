#!/bin/bash

PROM_URL="https://prometheus-production-0859.up.railway.app"
THRESHOLD=${1:-5}
HOURS=${2:-24}

# Période à scanner
END_TS=$(date +%s)
START_TS=$((END_TS - HOURS * 3600))

echo "=== SPIKES > ${THRESHOLD}s (last ${HOURS}h) ==="
echo ""

QUERY='head_lag_seconds{aggregator="mobula"}'
ENCODED_QUERY=$(printf %s "$QUERY" | jq -sRr @uri)

# Fetch avec step plus large pour moins de données
curl -s "${PROM_URL}/api/v1/query_range?query=${ENCODED_QUERY}&start=${START_TS}&end=${END_TS}&step=15" | \
jq -r --argjson threshold "$THRESHOLD" '
  .data.result[]? | 
  .metric as $m | 
  (.values // [])[] | 
  (.[1] | tonumber) as $val |
  select($val > $threshold) |
  "\(.[0])|\($m.region // "unknown")|\($m.chain // "unknown")|\($val)"
' | sort -t'|' -k1 -n | while IFS='|' read -r ts region chain val; do
  DATE=$(date -r "$ts" '+%Y-%m-%d %H:%M:%S')
  printf "%-19s | [%-8s] mobula - %-8s | %.2fs\n" "$DATE" "$region" "$chain" "$val"
done | tee /tmp/spikes_list.txt

echo ""
COUNT=$(wc -l < /tmp/spikes_list.txt | tr -d ' ')
echo "Total: $COUNT spikes found"
echo ""
echo "Usage: $0 [threshold] [hours]"
