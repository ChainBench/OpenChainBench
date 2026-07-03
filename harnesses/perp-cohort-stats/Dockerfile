FROM golang:1.24-alpine AS builder

WORKDIR /app
RUN apk add --no-cache git

COPY go.mod go.sum* ./
RUN go mod download || true

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/perp-cohort-stats ./cmd/script

FROM debian:bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/perp-cohort-stats /app/perp-cohort-stats

EXPOSE 2112

CMD ["/app/perp-cohort-stats"]
