#!/bin/bash
# Auto-update all RecordX calls to include region parameter

FILES="head_lag_monitor.go codex_rest_monitor.go mobula_rest_monitor.go quote_api_monitor.go geckoterminal_monitor.go moralis_rest_monitor.go metadata_coverage_monitor.go"

for file in $FILES; do
  if [ -f "$file" ]; then
    echo "Updating $file..."
    # Use perl for multiline regex
    perl -i -pe 's/RecordHeadLag\(([^)]+)\)/RecordHeadLag($1, config.MonitorRegion)/g' "$file"
    perl -i -pe 's/RecordRESTLatency\(([^)]+)\)/RecordRESTLatency($1, config.MonitorRegion)/g' "$file"
    perl -i -pe 's/RecordRESTError\(([^)]+)\)/RecordRESTError($1, config.MonitorRegion)/g' "$file"
    perl -i -pe 's/RecordQuoteAPILatency\(([^)]+)\)/RecordQuoteAPILatency($1, config.MonitorRegion)/g' "$file"
    perl -i -pe 's/RecordQuoteAPIError\(([^)]+)\)/RecordQuoteAPIError($1, config.MonitorRegion)/g' "$file"
    perl -i -pe 's/RecordHeadLagError\(([^)]+)\)/RecordHeadLagError($1, config.MonitorRegion)/g' "$file"
    perl -i -pe 's/RecordCodexBlockNumber\(([^)]+)\)/RecordCodexBlockNumber($1, config.MonitorRegion)/g' "$file"
    perl -i -pe 's/RecordMetadataCoverage\(([^)]+)\)/RecordMetadataCoverage($1, config.MonitorRegion)/g' "$file"
    perl -i -pe 's/RecordMetadataLatency\(([^)]+)\)/RecordMetadataLatency($1, config.MonitorRegion)/g' "$file"
    perl -i -pe 's/RecordPoolDiscoveryLatency\(([^)]+)\)/RecordPoolDiscoveryLatency($1, config.MonitorRegion)/g' "$file"
    perl -i -pe 's/RecordPoolDiscoveryError\(([^)]+)\)/RecordPoolDiscoveryError($1, config.MonitorRegion)/g' "$file"
  fi
done

echo "✓ All files updated"
