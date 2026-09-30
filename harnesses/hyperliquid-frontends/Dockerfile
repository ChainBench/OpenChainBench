FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/script ./cmd/script

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/script /app/script
COPY builders.json /app/builders.json
# Mirror of the daily feed plus state.json. Mount a volume here; the
# container runs as nonroot (uid 65532), so a bind mount must be writable
# by that uid.
VOLUME ["/data"]
EXPOSE 2112
ENTRYPOINT ["/app/script"]
CMD ["-builders", "/app/builders.json", "-data", "/data", "-addr", ":2112"]
