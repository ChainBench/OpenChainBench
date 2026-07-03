# Railway Deployment Guide

## Architecture

4 Railway services from the GitHub repo:

```
harnesses/bridge-monitor/
├── Dockerfile                    → Service "bridge-monitor"
└── deploy/
    ├── prometheus/Dockerfile     → Service "prometheus"
    ├── grafana/Dockerfile        → Service "grafana"
    └── alertmanager/Dockerfile   → Service "alertmanager"
```

---

## Deployment Steps

### 1. Service: bridge-monitor

**Railway Config:**
- **Root Directory**: `harnesses/bridge-monitor`
- **Dockerfile Path**: `./Dockerfile`
- **Port**: 9090

**Environment Variables:**
```env
MOBULA_API_KEY=your_key
WALLET_EVM_ADDRESS=0x...
WALLET_SOL_ADDRESS=...
EXECUTION_MODE=dry-run
MONITOR_REGION=railway-prod
```

**Service Name:** `bridge-monitor`

---

### 2. Service: prometheus

**Railway Config:**
- **Root Directory**: `harnesses/bridge-monitor/deploy/prometheus`
- **Dockerfile Path**: `./Dockerfile`
- **Port**: 9090

**Service Name:** `prometheus`

**Networking:** Accessible via `prometheus.railway.internal:9090`

---

### 3. Service: grafana (Public Dashboard)

**Railway Config:**
- **Root Directory**: `harnesses/bridge-monitor/deploy/grafana`
- **Dockerfile Path**: `./Dockerfile`
- **Port**: 3000

**Service Name:** `grafana`

**Networking:**
- ✅ **Generate public domain** (publicly accessible dashboard)
- Internal: `grafana.railway.internal:3000`

---

### 4. Service: alertmanager

**Railway Config:**
- **Root Directory**: `harnesses/bridge-monitor/deploy/alertmanager`
- **Dockerfile Path**: `./Dockerfile`
- **Port**: 9093

**Service Name:** `alertmanager`

**Networking:** `alertmanager.railway.internal:9093`

---

## Recommended Order

1. **prometheus** (no dependencies)
2. **alertmanager** (no dependencies)
3. **bridge-monitor** (scrapes to prometheus)
4. **grafana** (datasource to prometheus)

---

## Verification

### 1. Bridge Monitor
```bash
curl https://<bridge-monitor-url>.railway.app/metrics
```

### 2. Prometheus
- Go to **Status → Targets**
- Verify `bridge-monitor` is **UP**

### 3. Grafana (Public Dashboard)
- Dashboard displays without login (anonymous auth)
- Graphs show data after 2-3 minutes

---

## Local Development

Run the full stack locally:
```bash
cd deploy
docker-compose up -d
```

Access:
- **Prometheus**: http://localhost:9091
- **Grafana**: http://localhost:3000
- **Monitor Metrics**: http://localhost:9090/metrics
- **Alertmanager**: http://localhost:9093

---

## Key Points

✅ **Service Names** must be exactly: `bridge-monitor`, `prometheus`, `grafana`, `alertmanager`
✅ Railway internal URLs: `<service-name>.railway.internal`
✅ Grafana has **anonymous auth** = public access without login
✅ Prometheus scrapes bridge-monitor every 15s
✅ Quote tests run every **5 minutes**
✅ Execution tests run at fixed UTC times (10:00 UTC)

---

## Estimated Cost

- **Railway Hobby:** $5/service × 4 = **$20/month**
- **Execution costs:** ~$100/month (bridge fees for real transactions)

---

## Troubleshooting

### Prometheus not scraping bridge-monitor
```bash
railway logs prometheus
```
Verify `bridge-monitor.railway.internal:9090` is accessible.

### Grafana shows "No Data"
- Wait 2-3 minutes for data collection
- Check datasource: Settings → Data Sources → Prometheus
- URL should be: `http://prometheus.railway.internal:9090`
- Test query: `up`

### Service crashes on startup
- Check logs: `railway logs <service-name>`
- Verify port matches (9090, 3000, 9093)
- Verify Dockerfile path is correct
