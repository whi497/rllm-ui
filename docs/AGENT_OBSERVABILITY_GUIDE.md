# Agent Observability Guide

Step-by-step guide for agent developers to set up a local observability platform and view agent traces stored in BigQuery.

---

## Prerequisites

- **Docker** and **Docker Compose** installed
- **Google Cloud SDK** (`gcloud` CLI) installed
- Agent traces already exported to a BigQuery table from the `rllm` package

---

## 1. Clone and start the platform

```bash
git clone https://github.com/rllm-org/rllm-ui.git
cd rllm-ui
cp .env.example .env
```

## 2. Authenticate with GCP

Pick one of the two methods below.

### Method A: Application Default Credentials (recommended)

```bash
gcloud auth application-default login
```

This opens a browser for Google sign-in. Your credentials are saved to `~/.config/gcloud/` and mounted into the container automatically.

### Method B: Service account key file

1. Create a service account key in the GCP Console.
2. Save the JSON key file somewhere accessible (e.g., `./sa-key.json`).
3. Edit `docker-compose.bigquery.yml` — comment out the Method 1 volume and uncomment Method 2.
4. Add these to your `.env`:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/gcp/sa-key.json
GCP_SA_KEY_PATH=./sa-key.json
```

## 3. Start the platform

```bash
docker-compose -f docker-compose.yml -f docker-compose.bigquery.yml up
```

This starts two containers:
- **api** — FastAPI backend on port 8000
- **frontend** — Next.js UI on port 3000

## 4. Log in

Open [http://localhost:3000](http://localhost:3000).

Click **"Continue as local user"** to skip registration. This creates a local-only session — no email or password needed.

## 5. Configure BigQuery

On first visit to the Observability page, click the **BigQuery** tab. You'll see a setup form:

| Field | Description | Default |
|-------|-------------|---------|
| **GCP Project** | Your Google Cloud project ID (required) | — |
| **Dataset** | BigQuery dataset containing the traces | `agent_traces` |
| **Table** | Table name within the dataset | `rllm_traces` |

Fill in your values and click **Connect**.

> This configuration is saved to a local file and persists across container restarts. You can update it anytime from the **Settings** page or by re-selecting the BigQuery tab.

## 6. Explore your traces

Once connected, the Observability page shows:

- **Dashboard** — Aggregate metrics: total spans, LLM calls, tool calls, token usage, latency, and a time-series chart.
- **Sessions** — List of agent sessions derived from your spans. Click a session to see its full span timeline.

### Session detail view

Each session shows:
- **Flow view** — Visual timeline of spans (LLM calls, tool calls, agent spans) grouped by invocation.
- **Table view** — Flat list of all spans with type, duration, model, tokens, and errors.
- **Span detail** — Click any span to inspect its full data payload.

> **Note:** Skill distillation is not available when using BigQuery as a data source. This feature requires a PostgreSQL backend.

---

## Switching BigQuery projects or datasets

To point at a different table:

1. Go to **Settings** (gear icon in the sidebar).
2. Under **BigQuery**, enter the new project / dataset / table.
3. Click **Update**.

The change takes effect immediately — no restart needed.

---

## Troubleshooting

### "No project ID could be determined"

Your GCP credentials don't have a default project. Run:

```bash
gcloud config set project <your-project-id>
```

Then restart the containers.

### "quota exceeded" or "API not enabled"

Set a quota project for your ADC credentials:

```bash
gcloud auth application-default set-quota-project <your-project-id>
```

### BigQuery returns empty results

- Verify your table has data: `bq head <project>:<dataset>.<table>`
- Check that the table schema has the expected columns: `session_id`, `span_type`, `started_at`, `ended_at`, `data`, `ingested_at`.
- The dashboard queries the last 365 days by default. If your data is older, it won't appear on the dashboard but should still show in the Sessions list.

### Container can't find GCP credentials

Make sure you ran `gcloud auth application-default login` **before** starting the containers, and that you're using the `docker-compose.bigquery.yml` overlay which mounts `~/.config/gcloud` into the container.