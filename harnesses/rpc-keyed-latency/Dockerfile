FROM golang:1.24-alpine AS builder

WORKDIR /app
RUN apk add --no-cache git

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# BUILD_REF exists to make the layers below depend on something that changes.
#
# 2026-10-08: two merges to main (#2895, #2896) each triggered a build that
# reported SUCCESS, and the container was genuinely replaced — /proc/1 showed a
# fresh boot. But `grep` on the running /app/monitor found zero occurrences of
# any symbol from either commit. The builder was serving a cached image whose
# `COPY . .` layer predated them, so six deploys shipped the same binary.
#
# The file mtime is NOT a way to detect this: it comes from the image layer, so
# it reads as old even in a freshly started container. Checking the binary for
# a string you just added is the test that actually works.
ARG BUILD_REF=unset
RUN echo "build ref: $BUILD_REF" > /app/.build-ref

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/monitor ./cmd/script

FROM debian:bookworm-slim

WORKDIR /app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/monitor /app/monitor

EXPOSE 2112

CMD ["/app/monitor"]
