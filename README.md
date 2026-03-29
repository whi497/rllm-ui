# rLLM UI

Web interface for monitoring and analyzing [rLLM](https://github.com/rllm-org/rllm) training runs in real time. Think of wandb dedicated to rLLM, with powerful features such as episode/trajectory search, observability AI agent and more.

![rLLM UI Training Overview](docs/assets/training-overview.png)

---

## Getting Started

There are two ways to access rLLM UI:

1. **Cloud** — Use our hosted service at [ui.rllm-project.com](https://ui.rllm-project.com) (see [below](#cloud-setup)).
2. **Self-hosted** — Run locally from the repository (see [below](#self-hosted-setup)).

---

### Cloud Setup

1. Run `rllm login`
2. Sign up at [ui.rllm-project.com](https://ui.rllm-project.com)
3. Copy your API key (shown once at registration) and paste it in terminal (or save it as RLLM_API_KEY in `.env`)

That's it. No need to setup the database and other configurations.

> [!NOTE]
> The observability AI agent can be enabled by adding your ANTHROPIC_API_KEY in the **Settings** page in the UI — no extra configuration needed.
---

### Self-hosted Setup

#### Quick Start (Docker)

```bash
git clone https://github.com/rllm-org/rllm-ui.git
cd rllm-ui
cp .env.example .env
# Edit .env — add ANTHROPIC_API_KEY to enable the AI agent (optional)
docker-compose up
```

Open [http://localhost:3000](http://localhost:3000). Data is stored in a Docker volume and persists across restarts.

#### With BigQuery Traces

If your agent traces are in BigQuery, use the BigQuery overlay to mount your GCP credentials:

```bash
# Authenticate with GCP (one-time)
gcloud auth application-default login

# Start with BigQuery support
docker-compose -f docker-compose.yml -f docker-compose.bigquery.yml up
```

Then configure your BQ project, dataset, and table in the UI — see the [Agent Observability Guide](docs/AGENT_OBSERVABILITY_GUIDE.md) for detailed steps.

Alternatively, for service account key auth, see the comments in `docker-compose.bigquery.yml`.

#### Development without Docker

```bash
# Install dependencies
cd api && pip install -r requirements.txt
cd ../frontend && npm install

# Run (two terminals)
cd api && uvicorn main:app --reload --port 8000
cd frontend && npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

#### Database

- **SQLite** (default) — No setup required. Created automatically on first run.
- **PostgreSQL** — Adds full-text search with stemming and relevance ranking. Set `DATABASE_URL` in `.env`:

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/rllm_ui"
```

#### Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | No | — | Enables the built-in observability AI agent |
| `DATABASE_URL` | No | SQLite | PostgreSQL connection string |
| `RLLM_UI_URL` | No | `http://localhost:3000` | URL of your rllm-ui server (for training scripts) |

BigQuery project, dataset, and table are configured in the UI (Settings page or on first use). See the [Agent Observability Guide](docs/AGENT_OBSERVABILITY_GUIDE.md).

---

## Connecting rLLM to UI

### Training runs with script

Regardless of the service (cloud or self-hosted) you use, add `ui` to your trainer's logger list in your rLLM training script:

```bash
trainer.logger="['console','wandb','ui']"
```

### Training / Evaluation runs with rLLM CLI

If using our cloud service and rLLM CLI, you can run training and eval runs as such:

```bash
rllm train [dataset name]
rllm eval [dataset name]
```

If logged in, traces will automatically stream to the UI.

--- 

## How It Works

rLLM connects to the UI via the `UILogger` backend, registered as `"ui"` in the `Tracking` class ([`rllm/utils/tracking.py`](https://github.com/rllm-org/rllm/blob/main/rllm/utils/tracking.py)).

**On init**, the logger:

1. Creates a training session via `POST /api/sessions`
2. Starts a background heartbeat thread (for crash detection)
3. Wraps `stdout`/`stderr` with `TeeStream` to capture training logs

**During training**, the logger sends data over HTTP.

So the overall flow looks like:

![rLLM UI Architecture](docs/assets/rllm-ui-architecture.png)

---
