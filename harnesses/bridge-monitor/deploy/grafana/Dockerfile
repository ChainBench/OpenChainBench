FROM grafana/grafana:latest

USER root

# Copy provisioning configs (we're in grafana folder)
COPY provisioning /etc/grafana/provisioning

# Set permissions
RUN chown -R grafana:root /etc/grafana/provisioning

USER grafana

# Environment variables.
# Admin credentials are NOT baked into the image: set GF_SECURITY_ADMIN_USER
# and GF_SECURITY_ADMIN_PASSWORD on the Railway service (Grafana reads GF_*
# env vars natively).
ENV GF_AUTH_ANONYMOUS_ENABLED=true
ENV GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer

EXPOSE 3000
