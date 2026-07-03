FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile

# Default to localhost so the validate step works without any env vars.
# Railway overrides this to the Prom service's internal DNS, e.g.
# prometheus.railway.internal:9090
ENV PROM_UPSTREAM=127.0.0.1:9090

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
