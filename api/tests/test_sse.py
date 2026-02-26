"""Tests for SSE event generators."""

import asyncio
import json

import pytest
import routers.sse as sse_mod
from datastore.sqlite_store import SQLiteStore
from routers.sse import logs_event_generator, metrics_event_generator


@pytest.fixture
def store(tmp_path):
    """Create an isolated SQLite store for SSE tests."""
    s = SQLiteStore()
    s.db_path = tmp_path / "test_sse.db"
    s.init_db()
    return s


@pytest.fixture
def session_id(store):
    """Create a running session and return its id."""
    return store.create_session(
        project="test-proj", experiment="run-1", config={}, source_metadata={}
    )


async def _collect_events(gen, max_events=50):
    """Drain an async generator, collecting up to max_events data events."""
    events = []
    async for raw in gen:
        if raw.startswith("data: "):
            events.append(json.loads(raw[len("data: "):].strip()))
        if len(events) >= max_events:
            break
    return events


# ── Per-client state isolation ─────────────────────────────────────


@pytest.mark.asyncio
async def test_metrics_per_client_isolation(store, session_id):
    """Two clients on the same session should each see all metrics independently."""
    # Monkey-patch sleep to avoid real delays
    original_sleep = asyncio.sleep
    sse_mod.asyncio = type(asyncio)("fake_asyncio")
    sse_mod.asyncio.sleep = lambda _: original_sleep(0)
    sse_mod.asyncio.__dict__.update({k: v for k, v in asyncio.__dict__.items() if k != "sleep"})

    try:
        store.log_metrics(session_id, step=1, data={"loss": 0.5})
        store.log_metrics(session_id, step=2, data={"loss": 0.3})

        # Client A reads both metrics
        gen_a = metrics_event_generator(session_id, store)
        events_a = []
        async for raw in gen_a:
            if raw.startswith("data: "):
                events_a.append(json.loads(raw[len("data: "):].strip()))
            if len(events_a) >= 2:
                break

        assert len(events_a) == 2
        assert events_a[0]["step"] == 1
        assert events_a[1]["step"] == 2

        # Client B should ALSO see both metrics (not skipped by Client A)
        gen_b = metrics_event_generator(session_id, store)
        events_b = []
        async for raw in gen_b:
            if raw.startswith("data: "):
                events_b.append(json.loads(raw[len("data: "):].strip()))
            if len(events_b) >= 2:
                break

        assert len(events_b) == 2
        assert events_b[0]["step"] == 1
        assert events_b[1]["step"] == 2
    finally:
        sse_mod.asyncio = asyncio


@pytest.mark.asyncio
async def test_logs_per_client_isolation(store, session_id):
    """Two clients on the same session should each see all logs independently."""
    original_sleep = asyncio.sleep
    sse_mod.asyncio = type(asyncio)("fake_asyncio")
    sse_mod.asyncio.sleep = lambda _: original_sleep(0)
    sse_mod.asyncio.__dict__.update({k: v for k, v in asyncio.__dict__.items() if k != "sleep"})

    try:
        store.append_log(session_id, {"timestamp": "2024-01-01T00:00:00", "stream": "stdout", "message": "line 1"})
        store.append_log(session_id, {"timestamp": "2024-01-01T00:00:01", "stream": "stdout", "message": "line 2"})

        # Client A
        gen_a = logs_event_generator(session_id, store)
        events_a = []
        async for raw in gen_a:
            if raw.startswith("data: "):
                events_a.append(json.loads(raw[len("data: "):].strip()))
            if len(events_a) >= 2:
                break

        assert len(events_a) == 2

        # Client B sees the same logs
        gen_b = logs_event_generator(session_id, store)
        events_b = []
        async for raw in gen_b:
            if raw.startswith("data: "):
                events_b.append(json.loads(raw[len("data: "):].strip()))
            if len(events_b) >= 2:
                break

        assert len(events_b) == 2
        assert events_a[0]["id"] == events_b[0]["id"]
    finally:
        sse_mod.asyncio = asyncio


# ── Generator exits on terminal session ────────────────────────────


@pytest.mark.asyncio
async def test_metrics_generator_exits_on_completed_session(store, session_id):
    """Generator should stop when the session reaches a terminal status."""
    original_sleep = asyncio.sleep
    sse_mod.asyncio = type(asyncio)("fake_asyncio")
    sse_mod.asyncio.sleep = lambda _: original_sleep(0)
    sse_mod.asyncio.__dict__.update({k: v for k, v in asyncio.__dict__.items() if k != "sleep"})

    try:
        # Mark session completed before streaming
        store.complete_session(session_id, status="completed")

        gen = metrics_event_generator(session_id, store)
        events = []
        # The generator should exit on its own (at poll_count % 6 == 0, i.e. iteration 6)
        async for raw in gen:
            if raw.startswith("data: "):
                events.append(raw)

        # Generator terminated — this line is reached (not stuck in infinite loop)
        assert isinstance(events, list)
    finally:
        sse_mod.asyncio = asyncio


@pytest.mark.asyncio
async def test_logs_generator_exits_on_failed_session(store, session_id):
    """Logs generator should stop when session is failed."""
    original_sleep = asyncio.sleep
    sse_mod.asyncio = type(asyncio)("fake_asyncio")
    sse_mod.asyncio.sleep = lambda _: original_sleep(0)
    sse_mod.asyncio.__dict__.update({k: v for k, v in asyncio.__dict__.items() if k != "sleep"})

    try:
        store.complete_session(session_id, status="failed")

        gen = logs_event_generator(session_id, store)
        events = []
        async for raw in gen:
            if raw.startswith("data: "):
                events.append(raw)

        assert isinstance(events, list)
    finally:
        sse_mod.asyncio = asyncio


# ── No global shared state ─────────────────────────────────────────


def test_no_global_state_dicts():
    """Module should not have global _last_seen_* dicts."""
    assert not hasattr(sse_mod, "_last_seen_metrics")
    assert not hasattr(sse_mod, "_last_seen_logs")


# ── Data delivery ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_metrics_delivers_new_data(store, session_id):
    """Metrics added after generator starts should be delivered on next poll."""
    original_sleep = asyncio.sleep
    poll_count = {"n": 0}

    async def counting_sleep(_):
        poll_count["n"] += 1
        # On 1st sleep, inject new metrics so they appear on 2nd poll
        if poll_count["n"] == 1:
            store.log_metrics(session_id, step=10, data={"reward": 0.9})
        return await original_sleep(0)

    sse_mod.asyncio = type(asyncio)("fake_asyncio")
    sse_mod.asyncio.sleep = counting_sleep
    sse_mod.asyncio.__dict__.update({k: v for k, v in asyncio.__dict__.items() if k != "sleep"})

    try:
        gen = metrics_event_generator(session_id, store)
        events = []
        async for raw in gen:
            if raw.startswith("data: "):
                events.append(json.loads(raw[len("data: "):].strip()))
            # Stop collecting once we have the metric
            if len(events) >= 1:
                break

        assert len(events) == 1
        assert events[0]["step"] == 10
        assert events[0]["data"]["reward"] == 0.9
    finally:
        sse_mod.asyncio = asyncio
