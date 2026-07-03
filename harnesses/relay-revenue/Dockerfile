FROM golang:1.24-alpine AS builder

WORKDIR /app
RUN apk add --no-cache git

COPY go.mod go.sum* ./
RUN go mod download || true

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/monitor ./cmd/script

FROM debian:bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/monitor /app/monitor

# Persistent SQLite store written to /app/data.db. Mount a Railway
# volume at /app to survive redeploys; otherwise the harness rebuilds
# from "now" (lazy backfill) on every container boot.
EXPOSE 2112

CMD ["/app/monitor"]
