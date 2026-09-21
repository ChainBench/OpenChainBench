# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# Next's standalone server exits on SIGTERM on its own; with this set it leaves
# the signal to instrumentation.node.ts, which flushes the log-drain
# accumulator to the volume before exiting.
ENV NEXT_MANUAL_SIG_HANDLE=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Runs as root: the Railway volume at /data is mounted root-owned and the
# platform offers no fsGroup; the container holds one password and read keys.
RUN mkdir -p /data
EXPOSE 3210
CMD ["node", "server.js"]
