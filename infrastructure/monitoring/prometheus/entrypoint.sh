#!/bin/sh
# entrypoint.sh — write runtime secrets to files, then exec prometheus.
#
# Prometheus 2.x does not expand ${ENV_VAR} inside arbitrary config fields
# (only inside global.external_labels under --enable-feature=
# expand-external-labels). Configs that need a runtime secret must use a
# *_file directive pointing at a file whose contents are the secret.
#
# This script materialises each known runtime secret into a file under
# /etc/prometheus/secrets/ before exec'ing the prometheus binary. Files are
# 0400 root-owned so only the prometheus process (running as root by virtue
# of FROM prom/prometheus's USER directive) can read them.

set -eu

SECRETS_DIR=/etc/prometheus/secrets
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

write_secret() {
    name="$1"
    value="$2"
    if [ -n "$value" ]; then
        printf '%s' "$value" > "$SECRETS_DIR/$name"
        chmod 400 "$SECRETS_DIR/$name"
    else
        # Write empty file so password_file resolves; Prom will still send
        # an empty password rather than failing config parse.
        : > "$SECRETS_DIR/$name"
        chmod 400 "$SECRETS_DIR/$name"
    fi
}

# Secret for the hl-frontends-local-v2 scrape (Caddy basic_auth on OVH).
write_secret hl_bench_local_auth "${HL_BENCH_LOCAL_AUTH:-}"

# Hand off to prometheus with all CMD args preserved.
exec /bin/prometheus "$@"
