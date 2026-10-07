# This file is a copy of what runs at /usr/local/bin/hl-cleanup.sh on the
# Hyperliquid node box (15.235.224.14), checked in so the retention the
# reducer depends on is reviewable. The box is the source of truth; update
# both together.
#!/bin/bash
# hl-cleanup.sh — auto-cleanup for /mnt/hyperliquid/data
# Pattern: per-directory retention + 85% disk ceiling + 2-phase trash
# Runs every 15min via hl-cleanup.timer
#
# v2 (2026-06-09):
#  - Phase 0a: periodic_abci_states retention (3 days), preserving the
#    active hard-linked state file via inode check
#  - Phase 0b: node_raw_book_diffs_by_block retention (3 days)
#
# v3 (2026-10-07): v2 could not free space, and stopped running entirely the
# moment it was needed. Three defects, all in the ceiling phase:
#
#  1. `find ... | sort -n | head -1` returns non-zero under `pipefail` because
#     head closes the pipe on sort. With `set -e` that killed the whole run.
#     The phase only executes when the disk is ABOVE the ceiling, so the
#     script succeeded for months and began failing every 15 minutes the hour
#     the disk crossed it. Disk went 80% -> 86% in 15 hours unattended.
#  2. It moved files to $TRASH, which is on the SAME filesystem, so df did not
#     move and nothing was freed until the 3-day trash purge. A ceiling phase
#     that cannot free space on demand is not a ceiling.
#  3. It re-walked a 3 TB tree once per deleted file, so even unbroken it
#     would not have finished a batch.
#
# Plus the two largest directories had no retention at all: replica_cmds
# (1.1 TB over 85 run-directories, of which hl-node holds exactly one open)
# and node_fills_by_block (505 GB over 129 days, where 40 is ample).
#
# The ceiling now deletes directly. The 24h age floor and the open-file check
# are what keep that safe; the trash stays for the age-based phases, where
# there is no hurry and a mistake can be walked back.

set -uo pipefail
exec 9>/tmp/hl-cleanup.lock
flock -n 9 || { echo "already running" >&2; exit 0; }

DATA=/mnt/hyperliquid/data
TRASH=/mnt/hyperliquid/.trash
METRICS_DIR=/var/lib/node_exporter/textfile
METRICS=$METRICS_DIR/hl_cleanup.prom

MIN_SAFE_AGE_MIN=1440   # 24h floor for the writer's safety
MIN_AGE_DAYS=14         # generic age purge for node_logs/consensus
CEIL_PCT=85             # delete oldest above this
TRASH_PURGE_DAYS=3      # actual rm from trash after N days

PERIODIC_RETENTION_DAYS=3
RAW_DIFFS_RETENTION_DAYS=3
# replica_cmds is the node's record of applied actions. hl-node holds only
# the directory it is currently writing; everything older is inert, and
# Hyperliquid's own operator guidance is that the node never deletes these.
REPLICA_RETENTION_DAYS=5
# node_fills_by_block/hourly is the source the OCB harness reduces to
# per-builder daily totals. 40 days leaves the 30-day window plus a margin
# for a reducer outage. Do not lower this without checking hl-fills-reduce.
FILLS_RETENTION_DAYS=40

ACTIVE_ABCI=/home/ubuntu/hl/hyperliquid_data/abci_state.rmp
ABCI_INODE=""
if [ -f "$ACTIVE_ABCI" ]; then
    ABCI_INODE=$(stat -c%i "$ACTIVE_ABCI" 2>/dev/null || echo "")
fi

mkdir -p "$TRASH" "$METRICS_DIR"

disk_used_pct() { df --output=pcent "$DATA" 2>/dev/null | tail -1 | tr -dc 0-9 || echo 0; }

move_to_trash() {
    local f="$1"
    local rel="${f#$DATA/}"
    mkdir -p "$TRASH/$(dirname "$rel")" || return 1
    mv -- "$f" "$TRASH/$rel" || return 1
}

# Every path hl-node currently has open, read once. Checking lsof per file
# over hundreds of thousands of candidates is what made v2 unusable.
OPEN_PATHS=$(mktemp)
for pid in $(pgrep -x hl-node 2>/dev/null; pgrep -f hl-visor 2>/dev/null); do
    lsof -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p'
done | sort -u > "$OPEN_PATHS" || true

# is_open <path>  -- true when the path, or anything under it, is held open
is_open() {
    grep -qF -- "$1" "$OPEN_PATHS" 2>/dev/null
}

# Phase 0a: periodic_abci_states retention, skipping the live state file
PURGED_PERIODIC=0
if [ -d "$DATA/periodic_abci_states" ]; then
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        if [ -n "$ABCI_INODE" ]; then
            INO=$(stat -c%i "$f" 2>/dev/null || echo "")
            [ "$INO" = "$ABCI_INODE" ] && continue
        fi
        is_open "$f" && continue
        move_to_trash "$f" && PURGED_PERIODIC=$((PURGED_PERIODIC + 1))
    done < <(find "$DATA/periodic_abci_states" -type f -mtime +$PERIODIC_RETENTION_DAYS 2>/dev/null)
fi

# Phase 0b: node_raw_book_diffs_by_block retention
PURGED_RAW_DIFFS=0
if [ -d "$DATA/node_raw_book_diffs_by_block" ]; then
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        is_open "$f" && continue
        move_to_trash "$f" && PURGED_RAW_DIFFS=$((PURGED_RAW_DIFFS + 1))
    done < <(find "$DATA/node_raw_book_diffs_by_block" -type f -mtime +$RAW_DIFFS_RETENTION_DAYS 2>/dev/null)
fi

# Phase 0c (v3): replica_cmds retention, whole run-directories at a time.
# Deleted outright rather than trashed: these are the largest objects on the
# disk and routing a terabyte through a same-filesystem trash frees nothing.
PURGED_REPLICA=0
if [ -d "$DATA/replica_cmds" ]; then
    while IFS= read -r d; do
        [ -z "$d" ] && continue
        is_open "$d" && continue
        rm -rf -- "$d" && PURGED_REPLICA=$((PURGED_REPLICA + 1))
    done < <(find "$DATA/replica_cmds" -mindepth 1 -maxdepth 1 -type d -mtime +$REPLICA_RETENTION_DAYS 2>/dev/null)
fi

# Phase 0d (v3): node_fills_by_block/hourly retention, whole days at a time.
PURGED_FILLS=0
if [ -d "$DATA/node_fills_by_block/hourly" ]; then
    while IFS= read -r d; do
        [ -z "$d" ] && continue
        is_open "$d" && continue
        rm -rf -- "$d" && PURGED_FILLS=$((PURGED_FILLS + 1))
    done < <(find "$DATA/node_fills_by_block/hourly" -mindepth 1 -maxdepth 1 -type d -mtime +$FILLS_RETENTION_DAYS 2>/dev/null)
fi

# Phase 1: empty trash older than TRASH_PURGE_DAYS (final delete)
TRASH_BEFORE=$(du -sb "$TRASH" 2>/dev/null | cut -f1 || echo 0)
find "$TRASH" -mindepth 1 -mtime +$TRASH_PURGE_DAYS -delete 2>/dev/null || true
TRASH_AFTER=$(du -sb "$TRASH" 2>/dev/null | cut -f1 || echo 0)

# Phase 2: enforce the ceiling by deleting the oldest files outright.
# One tree walk into a sorted list, then delete down the list. df is re-read
# every 25 deletions rather than every one, because df is the slow part.
MOVED=0
PCT=$(disk_used_pct)
if [ "$PCT" -gt "$CEIL_PCT" ]; then
    CANDS=$(mktemp)
    find "$DATA" -type f -mmin +$MIN_SAFE_AGE_MIN \
        -not -path "*/periodic_abci_states/*" \
        -not -name "visor_abci_state.json" \
        -not -name "override_gossip_config.json" \
        -printf '%T@ %p\n' 2>/dev/null | sort -n > "$CANDS" || true
    while IFS= read -r line; do
        [ "$PCT" -le "$CEIL_PCT" ] && break
        [ "$MOVED" -ge 5000 ] && { echo "cleanup batch limit reached" >&2; break; }
        f=${line#* }
        [ -f "$f" ] || continue
        is_open "$f" && continue
        rm -f -- "$f" || continue
        MOVED=$((MOVED + 1))
        [ $((MOVED % 25)) -eq 0 ] && PCT=$(disk_used_pct)
    done < "$CANDS"
    rm -f "$CANDS"
    PCT=$(disk_used_pct)
fi

# Phase 3: age-based purge of node_logs/consensus (bulk, non-critical)
find "$DATA/node_logs/consensus" -type f -mtime +$MIN_AGE_DAYS -mmin +$MIN_SAFE_AGE_MIN -delete 2>/dev/null || true

rm -f "$OPEN_PATHS"

TMP=$(mktemp -p "$METRICS_DIR")
cat > "$TMP" <<EOF
# HELP hl_cleanup_last_success_seconds Unix timestamp of last successful run
# TYPE hl_cleanup_last_success_seconds gauge
hl_cleanup_last_success_seconds $(date +%s)
# HELP hl_cleanup_disk_used_pct Disk usage % on /mnt/hyperliquid after this run
# TYPE hl_cleanup_disk_used_pct gauge
hl_cleanup_disk_used_pct $PCT
# HELP hl_cleanup_disk_ceiling_pct The ceiling this run enforced
# TYPE hl_cleanup_disk_ceiling_pct gauge
hl_cleanup_disk_ceiling_pct $CEIL_PCT
# HELP hl_cleanup_trash_bytes Current size of trash directory in bytes
# TYPE hl_cleanup_trash_bytes gauge
hl_cleanup_trash_bytes $(du -sb "$TRASH" 2>/dev/null | cut -f1 || echo 0)
# HELP hl_cleanup_files_moved_total Files deleted this run (ceiling phase)
# TYPE hl_cleanup_files_moved_total counter
hl_cleanup_files_moved_total $MOVED
# HELP hl_cleanup_trash_freed_bytes Bytes freed by the final-delete phase this run
# TYPE hl_cleanup_trash_freed_bytes counter
hl_cleanup_trash_freed_bytes $((TRASH_BEFORE - TRASH_AFTER))
# HELP hl_cleanup_periodic_purged_total Files moved to trash from periodic_abci_states this run
# TYPE hl_cleanup_periodic_purged_total counter
hl_cleanup_periodic_purged_total $PURGED_PERIODIC
# HELP hl_cleanup_raw_diffs_purged_total Files moved to trash from node_raw_book_diffs_by_block this run
# TYPE hl_cleanup_raw_diffs_purged_total counter
hl_cleanup_raw_diffs_purged_total $PURGED_RAW_DIFFS
# HELP hl_cleanup_replica_dirs_purged_total replica_cmds run-directories deleted this run
# TYPE hl_cleanup_replica_dirs_purged_total counter
hl_cleanup_replica_dirs_purged_total $PURGED_REPLICA
# HELP hl_cleanup_fills_days_purged_total node_fills_by_block day-directories deleted this run
# TYPE hl_cleanup_fills_days_purged_total counter
hl_cleanup_fills_days_purged_total $PURGED_FILLS
EOF
mv "$TMP" "$METRICS"
