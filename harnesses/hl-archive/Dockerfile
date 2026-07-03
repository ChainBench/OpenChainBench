# hl-archive — Go service that ingests Hyperliquid CDN dumps into a local
# DuckDB file, exposes a small read-only HTTP API + Prometheus metrics, and
# republishes a tiny snapshot to Upstash Redis for the OCB site.
#
# Layout notes:
#   - go-duckdb v2 is a CGO module that bundles libduckdb statically (no apk
#     package needed) but still requires a C toolchain at build time and a
#     libc + libstdc++ at runtime, so we build with CGO_ENABLED=1 against
#     glibc and run on debian:bookworm-slim. distroless/static and alpine
#     are not viable here.
#   - The container ships `data/builders.json` baked in at /app/data so the
#     service has a usable default list even before any volume is mounted.
#   - Port 2114 is hardcoded by the harness for the shared OCB Prom scrape
#     contract (one bench = one fixed port). Railway $PORT is set to 2114
#     in railway.toml so the platform healthcheck routes to the same port.

# ------------------------------------------------------------------ build --
FROM golang:1.24-bookworm AS build

WORKDIR /src

# Toolchain needed by go-duckdb's cgo build (gcc, g++, make, headers).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
 && rm -rf /var/lib/apt/lists/*

# Cache module downloads as a separate layer.
COPY go.mod go.sum* ./
RUN go mod download

COPY . .

# Build the binary. CGO is required (DuckDB driver).
RUN CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
      go build -trimpath -ldflags="-s -w" \
      -o /out/hl-archive ./cmd/hl-archive

# -------------------------------------------------------------- runtime --
FROM debian:bookworm-slim

WORKDIR /app

# Runtime deps:
#   - ca-certificates : TLS to api.hyperliquid.xyz, stats-data.hyperliquid.xyz,
#                       Upstash REST.
#   - liblz4-1        : Hyperliquid CDN dumps are LZ4-framed; the go-duckdb
#                       binding embeds duckdb statically but the bench code
#                       uses pierrec/lz4 in pure Go, so this is only kept
#                       as a safety net if a future codepath links the
#                       system lz4 (small, ~50 KB, no harm leaving it).
#   - libstdc++6      : required by libduckdb embedded in the binary.
#   - wget            : container HEALTHCHECK probe.
#   - tzdata          : cron schedules / day-aligned aggregates need correct UTC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      liblz4-1 \
      libstdc++6 \
      wget \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

# Bake the default builders list into the image at the path the service
# reads via HL_ARCHIVE_BUILDERS_FILE.
COPY data/builders.json /app/data/builders.json

# Drop the binary on PATH so the ENTRYPOINT is unambiguous.
COPY --from=build /out/hl-archive /usr/local/bin/hl-archive

# DuckDB file lives on the persistent Railway volume mounted at /data;
# pre-create the mountpoint so the binary can open the file on cold boot
# before any volume is attached (local docker runs, smoke tests).
RUN mkdir -p /data

# Running as root: Railway mounts persistent volumes with root ownership
# and a non-root user (uid 10001) cannot write to /data, which makes
# DuckDB open() fail silently and the container restart in a loop with
# only "Mounting volume" logs. Switching back to non-root requires a
# chown entrypoint script that runs before USER drop, done in a follow-up.

EXPOSE 2114

# /health and /metrics are exempted from X-API-Key auth by the harness so
# this probe stays unauthenticated. 5s start period covers DuckDB open.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:2114/health || exit 1

ENTRYPOINT ["/usr/local/bin/hl-archive"]
CMD ["serve"]
