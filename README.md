# rLLM UI

Web interface for monitoring and analyzing [rLLM](https://github.com/rllm-org/rllm) training runs in real time. Think of wandb dedicated to rLLM, with powerful features such as episode/trajectory search, observability AI agent and more.

## Getting Started

There are two ways to access rLLM UI:

1. **Cloud** — Use our hosted service at [todo]. No setup required.
2. **Self-hosted** — Run locally from this repository (see [below](#self-hosted-setup)).

Regardless of the service you use, add `ui` to your trainer's logger list in your rLLM training script:

```bash
trainer.logger="['console','wandb','ui']"
```

## Self-hosted Setup

```bash
git clone https://github.com/rllm-org/rllm-ui.git
cd rllm-ui

# Install dependencies
cd api && pip install -r requirements.txt
cd ../frontend && npm install

# Run (two terminals)
cd api && uvicorn main:app --reload --port 3000
cd frontend && npm run dev
```

Open `http://localhost:5173` (or the port shown in the Vite output).

> **Custom API port:** If you run the API on a port other than 3000, update both sides so they know where to find it:
> - **rLLM training side** — `export RLLM_UI_URL="http://localhost:<port>"`
> - **rllm-ui frontend** — set `VITE_API_URL=http://localhost:<port>` in `frontend/.env.development`

### Database

rLLM UI stores sessions, metrics, episodes, trajectories, and logs in a database so they persist across restarts and are searchable. The cloud service uses PostgreSQL and handles setup automatically. For self-hosted, you have two options:

- **SQLite** (default) — No setup required. A local file (`api/rllm_ui.db`) is created on first run.
- **PostgreSQL** — Adds full-text search with stemming and relevance ranking. Set `DATABASE_URL` in `api/.env`:

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/rllm"
```

### AI Agent

rLLM UI includes a built-in AI agent that can query your training data using natural language. Currently experimental — more support coming soon. To enable it, set your Anthropic API key in `api/.env`:

```bash
ANTHROPIC_API_KEY="sk-ant-..."
```
