#!/bin/bash

PROM_URL="https://prometheus-production-0859.up.railway.app"
THRESHOLD=${1:-5}
HOURS=${2:-24}
DRY_RUN=${3:-false}

echo "=== AUTO CLEAN SPIKES > ${THRESHOLD}s (last ${HOURS}h) ==="
echo ""

# Fetch spikes
END_TS=$(date +%s)
START_TS=$((END_TS - HOURS * 3600))

QUERY='head_lag_seconds{aggregator="mobula"}'
ENCODED_QUERY=$(printf %s "$QUERY" | jq -sRr @uri)

echo "1. Fetching spikes..."
curl -s "${PROM_URL}/api/v1/query_range?query=${ENCODED_QUERY}&start=${START_TS}&end=${END_TS}&step=15" | \
jq -r --argjson threshold "$THRESHOLD" '
  .data.result[]? | 
  .metric as $m | 
  (.values // [])[] | 
  (.[1] | tonumber) as $val |
  select($val > $threshold) |
  "\(.[0])|\($m.region)|\($m.chain)|\($val)"
' > /tmp/raw_spikes.txt

TOTAL=$(wc -l < /tmp/raw_spikes.txt | tr -d ' ')
echo "   Found $TOTAL spike points"
echo ""

# Grouper les spikes consécutifs par région/chain
echo "2. Grouping consecutive spikes..."
GROUPS=0

cat /tmp/raw_spikes.txt | sort -t'|' -k2,2 -k3,3 -k1,1n | \
awk -F'|' '
BEGIN { 
  prev_region = "";
  prev_chain = "";
  prev_ts = 0;
  start_ts = 0;
  end_ts = 0;
}
{
  region = $2;
  chain = $3;
  ts = $1;
  val = $4;
  
  # Nouvelle série ou gap > 2 minutes
  if (region != prev_region || chain != prev_chain || (ts - prev_ts) > 120) {
    # Print previous group
    if (start_ts > 0) {
      print prev_region "|" prev_chain "|" start_ts "|" end_ts;
    }
    # Start new group
    start_ts = ts;
    end_ts = ts;
  } else {
    # Extend current group
    end_ts = ts;
  }
  
  prev_region = region;
  prev_chain = chain;
  prev_ts = ts;
}
END {
  # Print last group
  if (start_ts > 0) {
    print prev_region "|" prev_chain "|" start_ts "|" end_ts;
  }
}' > /tmp/spike_groups.txt

GROUPS=$(wc -l < /tmp/spike_groups.txt | tr -d ' ')
echo "   Grouped into $GROUPS spike ranges"
echo ""

# Afficher les groupes
echo "3. Spike ranges to delete:"
echo ""
cat /tmp/spike_groups.txt | while IFS='|' read -r region chain start_ts end_ts; do
  START_DATE=$(date -r "$start_ts" '+%Y-%m-%d %H:%M:%S')
  END_DATE=$(date -r "$end_ts" '+%Y-%m-%d %H:%M:%S')
  DURATION=$((end_ts - start_ts))
  printf "   [%-8s] mobula - %-8s | %s → %s (%ds)\n" "$region" "$chain" "$START_DATE" "$END_DATE" "$DURATION"
done

echo ""

if [ "$DRY_RUN" = "true" ]; then
  echo "DRY RUN - No deletion performed"
  echo "Run without 'true' parameter to actually delete"
  exit 0
fi

echo "4. Deleting spikes (with ±180s margin)..."
echo ""

DELETED=0
cat /tmp/spike_groups.txt | while IFS='|' read -r region chain start_ts end_ts; do
  # Add ±180s margin
  EXPANDED_START=$((start_ts - 180))
  EXPANDED_END=$((end_ts + 180))
  
  MATCH="head_lag_seconds{aggregator=\"mobula\",region=\"${region}\",chain=\"${chain}\"}"
  
  START_DATE=$(date -r "$start_ts" '+%Y-%m-%d %H:%M:%S')
  END_DATE=$(date -r "$end_ts" '+%Y-%m-%d %H:%M:%S')
  
  printf "   Deleting [%-8s] mobula - %-8s | %s → %s ... " "$region" "$chain" "$START_DATE" "$END_DATE"
  
  STATUS=$(curl -s -X POST "${PROM_URL}/api/v1/admin/tsdb/delete_series?match[]=$(printf %s "$MATCH" | jq -sRr @uri)&start=${EXPANDED_START}&end=${EXPANDED_END}" -w "%{http_code}")
  
  if [ "$STATUS" = "204" ]; then
    echo "✓"
    DELETED=$((DELETED + 1))
  else
    echo "✗ (status: $STATUS)"
  fi
done

echo ""
echo "5. Cleaning tombstones..."
CLEAN_STATUS=$(curl -s -X POST "${PROM_URL}/api/v1/admin/tsdb/clean_tombstones" -w "%{http_code}")
echo "   Status: $CLEAN_STATUS"

echo ""
echo "=== DONE ==="
echo "Deleted $GROUPS spike range(s)"
echo ""
echo "Usage: $0 [threshold] [hours] [dry-run-true/false]"
