# Railway Deployment Guide — rLLM-UI

Deploy rLLM-UI as **3 Railway services** within one project:

| Service | Source directory | Build method |
|---------|-----------------|--------------|
| **postgres** | — | Railway managed PostgreSQL |
| **api** | `rllm-ui/api` | Dockerfile |
| **frontend** | `rllm-ui/frontend` | Dockerfile |

---

## 1. Create the Railway project

```
railway init
```

Or create a new project from the Railway dashboard.

---

## 2. PostgreSQL service

Add a **PostgreSQL** plugin from the Railway dashboard (or `railway add`). This gives you a managed Postgres instance with automatic `DATABASE_URL`.

Take note of the **internal** connection string — it looks like:

```
postgresql://postgres:****@postgres.railway.internal:5432/railway
```

---

## 3. API service

### Source

Set root directory to `rllm-ui/api`. Railway will auto-detect the Dockerfile.

### Environment variables

#### Required

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference the Postgres plugin. Railway auto-injects this. |
| `DEPLOYMENT_MODE` | `cloud` | Enables secure (HTTPS-only) cookies |
| `JWT_SECRET` | *(random 32+ char string)* | `openssl rand -hex 32` to generate. Used for JWT signing + settings encryption. |
| `CORS_ORIGINS` | `https://<frontend-domain>.railway.app` | Your frontend's public Railway URL. Comma-separated if multiple. |

#### ClickHouse (required for agent observability)

| Variable | Value | Notes |
|----------|-------|-------|
| `CLICKHOUSE_HOST` | `your-host.clickhouse.cloud` | Your existing ClickHouse Cloud host |
| `CLICKHOUSE_PORT` | `8443` | Default for ClickHouse Cloud (HTTPS) |
| `CLICKHOUSE_USER` | `default` | Or your ClickHouse user |
| `CLICKHOUSE_PASSWORD` | *(your password)* | |
| `CLICKHOUSE_DATABASE` | `default` | Or your database name |
| `CLICKHOUSE_SECURE` | `true` | TLS enabled (default) |

#### Optional

| Variable | Value | Notes |
|----------|-------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Enables the built-in observability agent chat |
| `GITHUB_CLIENT_ID` | *(OAuth app ID)* | Enables GitHub login |
| `GITHUB_CLIENT_SECRET` | *(OAuth app secret)* | Required if `GITHUB_CLIENT_ID` is set |
| `GOOGLE_CLIENT_ID` | *(OAuth app ID)* | Enables Google login |
| `GOOGLE_CLIENT_SECRET` | *(OAuth app secret)* | Required if `GOOGLE_CLIENT_ID` is set |
| `SUPERUSER_EMAILS` | `admin@example.com` | Comma-separated. These users get admin access. |
| `TEAM_DOMAINS_EXTRA` | `company.com=MyCompany` | Map email domains to team names |
| `WEB_CONCURRENCY` | `4` | Uvicorn worker count (default 4) |

### Health check

Set the health check path to `/api/health` in Railway service settings.

### How it works

- Dockerfile runs `uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}`
- Railway injects `PORT` automatically
- `--proxy-headers` and `--forwarded-allow-ips='*'` are set for Railway's reverse proxy
- OAuth callback URLs are auto-resolved from `X-Forwarded-Host` headers (set by Railway)

---

## 4. Frontend service

### Source

Set root directory to `rllm-ui/frontend`. Railway will auto-detect the Dockerfile.

### Environment variables

| Variable | Value | Notes |
|----------|-------|-------|
| `BACKEND_URL` | `http://api.railway.internal:<PORT>` | **Use Railway private networking** for server-side rewrites. Replace `<PORT>` with the API service's internal port. Alternatively, use the API's public URL: `https://<api-domain>.railway.app` |

> **Important:** `BACKEND_URL` is used at **build time** (baked into Next.js rewrites) and at **runtime** (for the streaming chat proxy route). Railway makes env vars available at both stages.

### How it works

- Next.js standalone build with `output: "standalone"`
- All `/api/*` requests are server-side rewritten to `BACKEND_URL/api/*`
- The streaming chat endpoint (`/api/agent/chat/stream`) is a Next.js route handler that proxies to the backend
- Cookies (`credentials: 'include'`) are forwarded through the proxy
- Next.js standalone reads `PORT` from env automatically

### Private networking note

Railway services in the same project can communicate over the private network (`*.railway.internal`). This is **recommended** for `BACKEND_URL` to avoid egress costs and reduce latency. The frontend's Next.js server makes the proxy requests server-side, so private networking works.

To find the API's internal address:
1. Go to the API service in Railway dashboard
2. Under "Settings" → "Networking", find the private domain (e.g., `api.railway.internal`)
3. The port is whatever Railway assigned (check the `PORT` variable)

Example: `BACKEND_URL=http://api.railway.internal:8000`

---

## 5. Deployment order

1. **PostgreSQL** — create first, note the `DATABASE_URL`
2. **API** — deploy second, it will initialize the database schema on startup (with retries)
3. **Frontend** — deploy last, it needs the API's URL for `BACKEND_URL`

After the first deploy, subsequent deploys can happen in any order.

---

## 6. Custom domain (optional)

In Railway dashboard, go to each service → Settings → Networking → Custom Domain.

If you add a custom domain to the frontend:
- Update `CORS_ORIGINS` on the API service to include the new domain
- SSL is handled automatically by Railway

---

## 7. Connecting `rllm_telemetry` clients

The `rllm_telemetry` package streams agent spans to the rLLM-UI API via the `agent_endpoint` parameter. After deploying, point your telemetry clients at the API's **public** URL.

### Environment variables (on the client machine / CI)

| Variable | Value | Notes |
|----------|-------|-------|
| `RLLM_API_KEY` | *(your rLLM-UI API key)* | Found in rLLM-UI → Settings → API Key. Auto-read by `RllmConfig`. |
| `AGENT_ENDPOINT` | `https://<api-domain>.railway.app` | The API service's public Railway URL. Only used if your code reads this env var (as in the examples). |

### Usage

```python
import rllm_telemetry

rllm_telemetry.instrument(
    runner,
    backend="stdout",                                    # local console output
    agent_endpoint="https://<api-domain>.railway.app",   # deployed rLLM-UI API
)
```

Or using env vars (as in `examples/experiment_comparison.py`):

```bash
RLLM_API_KEY=rllm_abc123 \
AGENT_ENDPOINT=https://<api-domain>.railway.app \
ANTHROPIC_API_KEY=sk-ant-... \
python examples/experiment_comparison.py
```

### How it works

- `rllm_telemetry` sends spans to `{agent_endpoint}/api/agent-sessions/{session_id}/spans`
- The `RLLM_API_KEY` is sent as a `Bearer` token in the `Authorization` header
- The API resolves the token to a user via `get_user_by_api_key()` — all spans are scoped to that user
- Spans are stored in ClickHouse (via the API's ClickHouse connection configured above)
- `RLLM_AGENT_API_KEY` can be set as an override if you want a separate key for telemetry vs other API usage

### CORS note

`rllm_telemetry` is a Python HTTP client, not a browser — CORS does not apply. No changes to `CORS_ORIGINS` are needed for telemetry ingestion.

---

## 8. Post-deployment checklist

- [ ] Visit the frontend URL — you should see the login page
- [ ] Register a new account
- [ ] Check `/api/health` on the API service returns `{"status": "ok", "datastore": "PostgresStore"}`
- [ ] Verify the Observability page loads (confirms ClickHouse connection)
- [ ] Test the streaming chat if `ANTHROPIC_API_KEY` is set
- [ ] Check that cookies are secure (browser DevTools → Application → Cookies → `Secure` flag should be `true`)
- [ ] Test `rllm_telemetry` span ingestion: run an example with `AGENT_ENDPOINT` set to the API's public URL and verify spans appear in the Observability page

---

## Environment variable summary

### API service

```env
# Required
DATABASE_URL=postgresql://postgres:****@postgres.railway.internal:5432/railway
DEPLOYMENT_MODE=cloud
JWT_SECRET=<openssl rand -hex 32>
CORS_ORIGINS=https://your-frontend.railway.app

# ClickHouse
CLICKHOUSE_HOST=your-host.clickhouse.cloud
CLICKHOUSE_PORT=8443
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=<your-password>
CLICKHOUSE_DATABASE=default
CLICKHOUSE_SECURE=true

# Optional
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SUPERUSER_EMAILS=admin@example.com
```

### Frontend service

```env
BACKEND_URL=http://api.railway.internal:<PORT>
```

### rllm_telemetry client (on your machine / CI)

```env
RLLM_API_KEY=rllm_<your-api-key>
AGENT_ENDPOINT=https://<api-domain>.railway.app
```
