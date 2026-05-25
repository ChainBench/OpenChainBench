FROM golang:1.24-alpine AS builder

WORKDIR /build

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the monitor binary (continuous quote loop + execution scheduler
# that emits all the Prometheus metrics consumed by bridge-quote-latency
# and bridge-fee). The rebalance utility lives at ./cmd/rebalance and can
# be built separately with `go build ./cmd/rebalance`.
RUN CGO_ENABLED=0 GOOS=linux go build -o /bridge-monitor ./cmd/monitor

# Final stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /bridge-monitor .

EXPOSE 9090

CMD ["./bridge-monitor"]
