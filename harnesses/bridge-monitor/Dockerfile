FROM golang:1.24-alpine AS builder

WORKDIR /build

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the rebalance binary. The open-source tree currently ships the
# rebalance utility (a one-shot wallet topup helper). The continuous
# monitor that emits the Prometheus metrics consumed by the
# bridge-quote-latency and bridge-fee benches is operated separately;
# see the README for the data contract a fork should satisfy.
RUN CGO_ENABLED=0 GOOS=linux go build -o /bridge-rebalance ./cmd/rebalance

# Final stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /bridge-rebalance .

CMD ["./bridge-rebalance"]
