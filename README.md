# rLLM UI

Standalone web interface for monitoring and visualizing rLLM training runs.

## Features

- **Project Overview**: View all experiments' metrics overlaid on multi-series charts with distinct colors
- **Stable Experiment Colors**: Colors are deterministically assigned by session ID (not array index), so they never shift when experiments are added/removed
- **Custom Colors**: Right-click the eye icon in the sidebar to pick a custom color for any experiment (persisted in the database)
- **Experiment Visibility**: Toggle experiments on/off with eye icons in the sidebar
- **Real-time Streaming**: Metrics and logs update live via Server-Sent Events
- **Episode Browser**: Search and explore rollout data with full trajectory inspection
- **Workflow Visualization**: Interactive node-based diagrams of agent trajectories
- **Chat Agent**: Observability agent for querying training data via natural language
- **Drag-to-Resize**: Experiments sidebar panel is resizable
- **Auto-Collapse Navigation**: Sidebar collapses when navigating to deeper views

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+

### Installation

```bash
# Install backend dependencies
cd api
pip install -r requirements.txt

# Install frontend dependencies
cd ../frontend
npm install
```

### Running

**Terminal 1 - Backend API:**
```bash
cd api
uvicorn main:app --reload --port 3000
```

**Terminal 2 - Frontend:**
```bash
cd frontend
npm run dev
```

Open http://localhost:5173

## Architecture

```
rllm-ui/
├── Dockerfile                    # Multi-stage build (frontend + API)
├── railway.toml                  # Railway deployment config
├── api/                          # FastAPI backend (Python)
│   ├── main.py                   # App entry, CORS, router registration
│   ├── models.py                 # Pydantic request/response models
│   ├── agent/                    # Observability agent (requires ANTHROPIC_API_KEY)
│   │   ├── agent.py              # Agent orchestration
│   │   ├── prompts.py            # System prompts
│   │   └── tools.py              # Tool definitions and implementations
│   ├── datastore/                # Database abstraction
│   │   ├── base.py               # Abstract DataStore interface
│   │   ├── factory.py            # SQLite or PostgreSQL based on DATABASE_URL
│   │   ├── sqlite_store.py       # SQLite (default, zero-config)
│   │   └── postgres_store.py     # PostgreSQL (full-text search, stemming)
│   ├── routers/                  # API endpoints
│   │   ├── sessions.py           # Session + project CRUD
│   │   ├── episodes.py           # Episode data + search
│   │   ├── metrics.py            # Training metrics
│   │   ├── sse.py                # Server-Sent Events for live updates
│   │   ├── logs.py               # Training logs
│   │   ├── trajectory_groups.py  # Trajectory group data
│   │   ├── agent.py              # Chat agent endpoint
│   │   └── health.py             # Health check + datastore info
│   └── tests/                    # Backend tests
└── frontend/                     # React + TypeScript + Vite
    └── src/
        ├── App.tsx               # Routes and layout
        ├── components/
        │   ├── Sidebar.tsx               # Collapsible sidebar + experiments panel
        │   ├── TrainingRunsList.tsx       # Project cards grid (home page)
        │   ├── ProjectOverview.tsx        # Multi-experiment chart overlay
        │   ├── TrainingRunDetail.tsx      # Single experiment view with tabs
        │   ├── MetricsDashboard.tsx       # Grouped metric charts
        │   ├── RewardChart.tsx            # Single-series line chart
        │   ├── EpisodePanel.tsx           # Episode browser
        │   ├── EpisodeViewer.tsx          # Episode detail viewer
        │   ├── LogViewer.tsx             # Log viewer component
        │   ├── LogsPanel.tsx             # Training log viewer
        │   ├── ChatPanel.tsx             # Chat agent interface
        │   ├── WorkflowDiagram.tsx       # Workflow visualization
        │   ├── ProgressBar.tsx           # Training progress indicator
        │   ├── ColorPicker.tsx            # Experiment color customization popover
        │   ├── ActionMenu.tsx            # Context menu (rename/delete)
        │   ├── ConfirmDialog.tsx         # Confirmation dialog for destructive actions
        │   ├── HighlightedText.tsx       # Search match highlighting
        │   ├── MetricSelectorModal.tsx   # Metric selection dialog
        │   ├── icons.tsx                 # MUI icon re-exports
        │   └── workflow/                 # Workflow diagram components
        │       ├── StepNode.tsx          # Step node renderer
        │       ├── StepDetailPanel.tsx   # Step detail side panel
        │       ├── TaskNode.tsx          # Task node renderer
        │       ├── TrajectoryHeaderNode.tsx  # Trajectory header node
        │       └── workflowUtils.ts      # Layout and utility functions
        ├── contexts/
        │   └── ExperimentVisibilityContext.tsx  # Show/hide experiments on charts
        ├── hooks/
        │   └── useSSE.ts                 # SSE hook for live metric streaming
        └── utils/
            └── experimentColors.ts       # Deterministic color assignment
```

## Frontend Routes

| Path | View | Description |
|------|------|-------------|
| `/` | `TrainingRunsList` | Project cards with run counts |
| `/project/:projectId` | `ProjectOverview` | All experiments overlaid on multi-series charts |
| `/runs/:sessionId` | `TrainingRunDetail` | Single experiment with tabs (Charts, Training, Logs, Code, Metadata) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check + datastore info |
| GET | `/api/sessions` | List all sessions |
| GET | `/api/sessions/projects` | List projects with session summaries |
| POST | `/api/sessions` | Create a session |
| GET | `/api/sessions/{id}` | Get session by ID |
| PATCH | `/api/sessions/{id}` | Update session (rename and/or set color) |
| DELETE | `/api/sessions/{id}` | Delete session and all children |
| PATCH | `/api/sessions/projects/{id}` | Rename a project |
| DELETE | `/api/sessions/projects/{id}` | Delete project and cascade |
| POST | `/api/sessions/{id}/complete` | Mark session as completed |
| GET | `/api/sessions/{id}/metrics` | Get metrics for a session |
| GET | `/api/sessions/{id}/metrics/stream` | SSE stream for live metrics |
| POST | `/api/metrics` | Log metrics for a session |
| GET | `/api/episodes` | Get episodes (query: `session_id`) |
| GET | `/api/episodes/search` | Search episodes (query: `q`, `session_id`, `step`, `limit`) |
| GET | `/api/episodes/{id}` | Get single episode with trajectories |
| POST | `/api/episodes` | Create an episode |
| GET | `/api/trajectory-groups` | List trajectory groups (query: `session_id`, `step`) |
| GET | `/api/trajectory-groups/{id}` | Get trajectory group with rollout data |
| POST | `/api/trajectory-groups` | Create a trajectory group |
| GET | `/api/logs` | Get logs (query: `session_id`) |
| GET | `/api/logs/stream` | SSE stream for live logs |
| POST | `/api/logs/batch` | Batch-create log entries |
| POST | `/api/agent/chat` | Chat with observability agent |

## Data Model

```
Project
├── name: string (unique)
└── Sessions[]

Session (training run)
├── project_id: FK           # References Project
├── experiment: string       # Experiment name
├── config: JSON             # Hydra config snapshot
├── color: string?           # User-chosen hex color (e.g. "#dc2626")
├── Metrics[]                # Time-series data (step → key/value pairs)
├── Episodes[]               # Rollout data per step
│   ├── task: JSON           # Problem/task description
│   ├── reward: float
│   ├── Trajectories[]       # Agent trajectories (solver, judge, etc.)
│   │   └── Steps[]
│   │       ├── observation, thought, action, model_response
│   │       ├── chat_completions[]  # Full conversation (role, content, reasoning)
│   │       └── reward, advantage, mc_return
│   └── metrics: JSON        # Per-episode metrics (solver_acc, judge_acc)
├── TrajectoryGroups[]       # Cross-episode trajectory comparisons
│   ├── group_id: string     # Format: "task_id:trajectory_name"
│   ├── avg_reward, correct_count, total_count
│   └── metadata: [{ episode_id }]
└── Logs[]                   # Structured log entries (stdout/stderr)
```

## Database Setup

The UI supports two database backends: **SQLite** (default) and **PostgreSQL**.

### SQLite (Default)

SQLite requires no additional setup. The database file (`rllm_ui.db`) is created automatically in the `api/` directory.

```bash
# Just start the server - SQLite is used by default
cd api
uvicorn main:app --reload --port 3000
```

### PostgreSQL

PostgreSQL provides advanced full-text search with stemming and relevance ranking.

```bash
# Start PostgreSQL container
docker run -d \
  --name rllm-postgres \
  -e POSTGRES_PASSWORD=secret \
  -e POSTGRES_DB=rllm \
  -p 5433:5432 \
  postgres:15

# Start the backend with PostgreSQL
cd api
DATABASE_URL="postgresql://postgres:secret@localhost:5433/rllm" uvicorn main:app --reload --port 3000
```

Or create a `.env` file in `api/`:
```bash
DATABASE_URL=postgresql://postgres:secret@localhost:5433/rllm
```

### Search Feature Comparison

| Feature | SQLite | PostgreSQL |
|---------|--------|------------|
| Substring matching | Yes | Yes |
| Stemming ("subtract" matches "subtraction") | No | Yes |
| Relevance ranking | No | Yes |
| Boolean queries | No | Yes |

Verify the active database:
```bash
curl http://localhost:3000/api/health
# {"status": "ok", "datastore": "SQLiteStore"} or "PostgresStore"
```

## Deployment

### Docker

```bash
docker build -t rllm-ui .
docker run -p 3000:3000 rllm-ui
```

The Dockerfile uses a multi-stage build: Node.js builds the frontend, then the built assets are served by the FastAPI backend.

### Railway

The project includes a `railway.toml` for one-click deployment to [Railway](https://railway.app). The health check is configured at `/api/health`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | SQLite (`rllm_ui.db`) | Set to `postgresql://...` for Postgres |
| `ANTHROPIC_API_KEY` | (none) | Enables the chat observability agent |
| `VITE_API_URL` | `http://localhost:3000` | API URL for the frontend |

## Using with rLLM Training

The rLLM training framework sends metrics and episode data to this UI via the `UILogger`. To enable UI logging during training, add `"ui"` to your logger config in rLLM:

```yaml
trainer:
  logger:
    - wandb
    - ui
```

Or programmatically:
```python
tracking_logger = Tracking(
    project_name="my_project",
    experiment_name="my_experiment",
    default_backend=["wandb", "ui"],
    config=config,
)
```

The `UILogger` class (in `rllm/utils/tracking.py`) sends training metrics and episode data to this API server via HTTP.
