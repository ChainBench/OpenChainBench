FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.ts ./
# Railway injects $PORT — Next 15 reads it automatically.
EXPOSE 3000
# Call the next binary directly (npm run start fails to resolve `next` from
# PATH in some container contexts even when node_modules/.bin is populated).
CMD ["./node_modules/.bin/next", "start"]
