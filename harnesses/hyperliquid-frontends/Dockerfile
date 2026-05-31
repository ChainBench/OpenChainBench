FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -o /out/script ./cmd/script

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/script /app/script
COPY builders.json /app/builders.json
EXPOSE 2112
ENTRYPOINT ["/app/script"]
