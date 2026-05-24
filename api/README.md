# rLLM UI API Backend

FastAPI backend for the rLLM UI monitoring platform.

## Setup

```bash
cd rllm-ui/api
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows
pip install -r requirements.txt
```

## Running

```bash
uvicorn main:app --reload --port 8000
```

## Testing

```bash
pytest -v
```
