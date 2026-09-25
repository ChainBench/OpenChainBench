FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/bridge-flows ./cmd/script

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/bridge-flows /app/bridge-flows
# Hourly burn buckets and the per-chain cursor live in /data/state.json.
# Runs as nonroot (uid 65532): a bind mount must be writable by that uid.
VOLUME ["/data"]
EXPOSE 2112
ENTRYPOINT ["/app/bridge-flows"]
