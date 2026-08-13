FROM golang:1.24-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app/collector ./cmd/collector
RUN CGO_ENABLED=0 go build -o /app/materializer ./cmd/materializer

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /app/collector /app/collector
COPY --from=builder /app/materializer /app/materializer
COPY migrations/ /app/migrations/
