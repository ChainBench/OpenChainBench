# Build stage
FROM golang:1.24-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/monitor ./cmd/script

# Runtime stage
FROM debian:bookworm-slim

WORKDIR /app

# Install runtime dependencies.
#
# chromium + minimal X / font libs are required for chromedp, which the
# GMGN.ai head-lag monitor uses to mint Cloudflare cf_clearance cookies
# before dialing wss://gmgn.ai/ws. When GMGN_ENABLED != true the binary
# skips that monitor and Chromium stays idle — the only cost is image
# size (~200MB extra).
RUN apt-get update && apt-get install -y \
    ca-certificates \
    chromium \
    fonts-liberation \
    libnss3 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Point chromedp at the chromium binary debian ships at /usr/bin/chromium.
ENV CHROME_PATH=/usr/bin/chromium

# Copy binary from builder
COPY --from=builder /app/monitor /app/monitor

# Expose metrics port
EXPOSE 2112

# Run the monitor
CMD ["/app/monitor"]
