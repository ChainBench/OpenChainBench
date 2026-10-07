FROM golang:1.24-alpine AS builder

WORKDIR /app
RUN apk add --no-cache git

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/monitor .

FROM debian:bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/monitor /app/monitor

# Nothing else ships in the image. The harness holds no state and no catalogue:
# every figure is recomputed from the upstream API on each pass, so a restart
# is always correct and there is nothing to migrate.
EXPOSE 2115

CMD ["/app/monitor"]
