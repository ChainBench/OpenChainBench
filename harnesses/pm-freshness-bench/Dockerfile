FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/script ./cmd/script

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && update-ca-certificates
WORKDIR /app
COPY --from=build /out/script /app/script
EXPOSE 2112
ENTRYPOINT ["/app/script"]
