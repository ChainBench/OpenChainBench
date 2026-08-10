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

# Install runtime dependencies + Chromium for in-process JWE scraping
RUN apt-get update && apt-get install -y \
    ca-certificates \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Copy binary from builder
COPY --from=builder /app/monitor /app/monitor

# Expose metrics port
EXPOSE 2112

# Run the monitor
CMD ["/app/monitor"]
