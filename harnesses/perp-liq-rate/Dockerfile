# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS builder

WORKDIR /src

# -mod=mod lets the build materialize go.sum on first build if it is absent.
ENV CGO_ENABLED=0

COPY go.mod ./
RUN go mod download

COPY . .
RUN go build -trimpath -ldflags="-s -w" -o /out/perp-liq-rate ./cmd/script

FROM alpine:3.20

RUN apk add --no-cache ca-certificates && adduser -D -H perpliq
USER perpliq

COPY --from=builder /out/perp-liq-rate /usr/local/bin/perp-liq-rate

EXPOSE 2112
ENTRYPOINT ["/usr/local/bin/perp-liq-rate"]
