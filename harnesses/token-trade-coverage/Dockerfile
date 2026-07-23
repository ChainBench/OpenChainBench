FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/scanner ./cmd/scanner

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && update-ca-certificates
COPY --from=build /out/scanner /usr/local/bin/scanner
EXPOSE 2112
ENTRYPOINT ["/usr/local/bin/scanner"]
