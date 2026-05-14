# Volume Cleanup Endpoint

## Overview

The monitor exposes an admin endpoint at `/admin/cleanup` that allows selective deletion of old data from Prometheus and Grafana volumes based on timestamp.

## Setup

1. **Set environment variable on Railway:**

```bash
ADMIN_CLEANUP_TOKEN=<your-secret-token>
```

2. **Optional: Configure data paths** (defaults shown):

```bash
PROMETHEUS_DATA_PATH=/data/prometheus
GRAFANA_DATA_PATH=/data/grafana
```

## Usage

### Delete data before a specific date

```bash
curl -X DELETE \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN" \
  "https://monitor-production.railway.app/admin/cleanup?before=2026-04-10T00:00:00Z"
```

### Delete data older than 7 days

```bash
curl -X DELETE \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN" \
  "https://monitor-production.railway.app/admin/cleanup?before=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)"
```

### Delete data older than 30 days

```bash
curl -X DELETE \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN" \
  "https://monitor-production.railway.app/admin/cleanup?before=$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)"
```

## Response

Success response:
```
✅ Cleanup complete

Deleted 42 files/directories before 2026-04-10T00:00:00Z

Paths cleaned:
- /data/prometheus
- /data/grafana
```

## How It Works

1. The endpoint accepts a `before` timestamp in RFC3339 format (e.g., `2026-04-10T00:00:00Z`)
2. It scans all files and directories in the configured data paths
3. Any item with modification time **before** the specified timestamp is deleted
4. Returns the total count of deleted items

## Security

- **Authentication required**: All requests must include `Authorization: Bearer <token>` header
- **Method restriction**: Only `DELETE` HTTP method is allowed
- **Logging**: All cleanup attempts (successful and unauthorized) are logged

## Error Responses

- `401 Unauthorized`: Missing or invalid bearer token
- `400 Bad Request`: Missing or invalid `before` timestamp parameter
- `405 Method Not Allowed`: Using HTTP method other than DELETE
- `500 Internal Server Error`: Filesystem errors during cleanup

## Notes

- The cleanup is **destructive** and **irreversible**
- Always test with a recent timestamp first to verify behavior
- The endpoint only deletes data, it does not affect running Prometheus/Grafana processes
- Data currently being written by Prometheus/Grafana will have recent modification times and won't be deleted
