#!/usr/bin/env bash
# Editorial guard for hand-written positioning + expert_take fields.
# Existing seo_title / question / FAQ / intro fields are outside the
# scope of this script; their editorial policy is enforced elsewhere.
#
# Extracts positioning: | and expert_take: | blocks from
# alternatives/*.yml and answers/*.yml, then greps for hard-rule
# violations (em/en dashes, marketing adjectives, first/second person
# pronouns, year mentions, vendor pricing leaks).
#
# Exit 0 clean, exit 1 with per-line diagnostics.
set -u
cd "$(dirname "$0")/.."

# Extract the positioning and expert_take literal blocks into a
# temp file, tagged with the source file + starting line so grep
# output stays actionable.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

python3 - <<'PY' > "$TMP"
import os, re
for d in ("alternatives", "answers"):
    if not os.path.isdir(d):
        continue
    for name in sorted(os.listdir(d)):
        if not name.endswith(".yml"):
            continue
        path = os.path.join(d, name)
        lines = open(path).read().splitlines()
        i, n = 0, len(lines)
        while i < n:
            m = re.match(r"^(positioning|expert_take):\s*\|\s*$", lines[i])
            if not m:
                i += 1
                continue
            field = m.group(1)
            start = i + 1
            i += 1
            while i < n and (lines[i].startswith("  ") or lines[i].strip() == ""):
                i += 1
            for k, ln in enumerate(lines[start:i]):
                print(f"{path}:{field}:{start + k + 1}:{ln}")
PY

FAIL=0
report() { echo "$@"; FAIL=1; }

# Hard rules
# Pronouns are matched case-sensitively so "US" (United States) and
# "US-based" don't false-flag as "us". Marketing list intentionally
# excludes "premier" and "top" because they collide with proper nouns
# (Kalshi Premier tier, top of book, top-of-book, top-of-stack).
while IFS= read -r hit; do report "[DASH] $hit"; done < <(python3 -c "
import sys
for ln in open(sys.argv[1]):
    if '—' in ln or '–' in ln:
        sys.stdout.write(ln)
" "$TMP")
while IFS= read -r hit; do report "[MARKETING] $hit"; done < <(grep -iE '\b(leading|blazing|cutting[- ]edge|industry[- ]leading|revolutionary|world[- ]class|unmatched|unparalleled|next[- ]gen)\b' "$TMP" || true)
while IFS= read -r hit; do report "[PRONOUN] $hit"; done < <(grep -E '\b(we|our|ours|you|your|yours)\b' "$TMP" || true)
while IFS= read -r hit; do report "[PRONOUN-US] $hit"; done < <(grep -E '\bus\b' "$TMP" || true)
while IFS= read -r hit; do report "[YEAR] $hit"; done < <(grep -E '\b(2024|2025|2026|2027)\b' "$TMP" || true)

if [ "$FAIL" -eq 0 ]; then
  echo "editorial: clean"
  exit 0
else
  echo
  echo "editorial: violations above. rules are in scripts/editorial-check.sh."
  exit 1
fi
