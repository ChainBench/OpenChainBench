FROM golang:1.24-alpine AS builder

# Hardcoded env per user request so the Railway service has zero
# configuration beyond pointing at this Dockerfile. Rotate these secrets
# by rebuilding the image, not via Railway dashboard env vars.
ENV MOBULA_API_KEY=b774ca8c-d220-47ec-aacc-b4c8379fdb3d
ENV LOGS_TOKEN=relay-revenue-logs-1xrvDsHWB29q
ENV POLL_INTERVAL_SEC=300

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux go build -o /monitor ./cmd/monitor

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /monitor /monitor

# Same env in the runtime stage so the process sees them at startup.
ENV MOBULA_API_KEY=b774ca8c-d220-47ec-aacc-b4c8379fdb3d
ENV LOGS_TOKEN=relay-revenue-logs-1xrvDsHWB29q
ENV POLL_INTERVAL_SEC=300

EXPOSE 2112
# No HEALTHCHECK: Railway probes whatever port it expects (PORT env var,
# not :2112) and gets "service unavailable" because the OCB harness
# convention is to hardcode :2112 for the shared Prom to scrape. The
# implicit liveness signal is the running process itself; /healthz stays
# available on :2112 for manual debugging.

ENTRYPOINT ["/monitor"]
