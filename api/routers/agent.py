"""Agent router - chat endpoint for the Observability Agent."""

import json
import logging

from auth import CurrentUser, IS_CLOUD
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from models import ChatSessionCreate, ChatSessionResponse, ChatMessageResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agent", tags=["agent"])


def _resolve_agent(request: Request, user: dict | None):
    """Return an ObservabilityAgent for this request.

    Cloud mode: only per-user keys (configured in Settings).
    Local mode: global agent from ANTHROPIC_API_KEY env var.
    """
    if IS_CLOUD:
        if user:
            from encryption import decrypt_value

            store = request.app.state.store
            settings = store.get_user_settings(user["id"])
            encrypted_key = settings.get("anthropic_api_key")
            if encrypted_key:
                api_key = decrypt_value(encrypted_key)
                from agent import ObservabilityAgent

                return ObservabilityAgent(datastore=store, api_key=api_key)
        return None  # no fallback to global agent in cloud mode

    # Local mode: use global agent
    return getattr(request.app.state, "agent", None)


class ChatMessage(BaseModel):
    """A single message in the conversation."""

    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    """Request body for chat endpoint."""

    message: str
    session_id: str | None = None
    chat_session_id: str | None = None  # Links to persistent chat session
    history: list[ChatMessage] | None = None  # Previous conversation messages
    model: str | None = None  # Override model (e.g. "claude-haiku-4-5-20251001")


class ChatResponse(BaseModel):
    """Response from chat endpoint."""

    message: str
    sources: list[str] = []
    error: str | None = None


# ── Chat session CRUD endpoints ──────────────────────────────────


@router.get("/sessions", response_model=list[ChatSessionResponse])
def list_chat_sessions(request: Request, session_id: str, user: CurrentUser):
    """List all chat sessions for a training run."""
    store = request.app.state.store
    sessions = store.get_chat_sessions(session_id)
    return sessions


@router.post("/sessions", response_model=ChatSessionResponse)
def create_chat_session(request: Request, body: ChatSessionCreate, user: CurrentUser):
    """Create a new chat session for a training run."""
    store = request.app.state.store
    session = store.create_chat_session(body.session_id, body.title)
    return session


@router.delete("/sessions/{chat_session_id}")
def delete_chat_session(request: Request, chat_session_id: str, user: CurrentUser):
    """Delete a chat session and all its messages."""
    store = request.app.state.store
    deleted = store.delete_chat_session(chat_session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return {"ok": True}


@router.get("/sessions/{chat_session_id}/messages", response_model=list[ChatMessageResponse])
def get_chat_messages(request: Request, chat_session_id: str, user: CurrentUser):
    """Get all messages for a chat session."""
    store = request.app.state.store
    messages = store.get_chat_messages(chat_session_id)
    return messages


# ── Chat endpoints ───────────────────────────────────────────────


@router.post("/chat", response_model=ChatResponse)
def chat(request: Request, body: ChatRequest, user: CurrentUser):
    """Chat with the observability agent.

    Send a natural language message and get insights about your training runs.
    Optionally provide a session_id to focus the conversation on a specific session.
    """
    agent = _resolve_agent(request, user)
    if agent is None:
        detail = (
            "Agent not available. Configure your Anthropic API key in Settings."
            if IS_CLOUD
            else "Agent not available. Set the ANTHROPIC_API_KEY environment variable."
        )
        raise HTTPException(status_code=503, detail=detail)

    try:
        # Convert history to list of dicts if provided
        history = None
        if body.history:
            history = [{"role": m.role, "content": m.content} for m in body.history]

        response = agent.chat(message=body.message, session_id=body.session_id, history=history, model=body.model)
        return ChatResponse(
            message=response.message,
            sources=response.sources,
            error=response.error,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/chat/stream")
def chat_stream(request: Request, body: ChatRequest, user: CurrentUser):
    """Stream chat responses from the observability agent.

    Returns Server-Sent Events (SSE) with the following event types:
    - tool_call: {"type": "tool_call", "tool": "tool_name"}
    - text: {"type": "text", "content": "chunk of text"}
    - done: {"type": "done", "sources": ["tool1(...)", "tool2(...)"], "chat_session_id": "..."}
    - error: {"type": "error", "message": "error message"}
    """
    agent = _resolve_agent(request, user)
    if agent is None:
        detail = (
            "Agent not available. Configure your Anthropic API key in Settings."
            if IS_CLOUD
            else "Agent not available. Set the ANTHROPIC_API_KEY environment variable."
        )
        raise HTTPException(status_code=503, detail=detail)

    store = request.app.state.store

    # Convert history to list of dicts if provided
    history = None
    if body.history:
        history = [{"role": m.role, "content": m.content} for m in body.history]

    # Persist user message BEFORE streaming so it survives tab close
    chat_session_id = body.chat_session_id
    if body.session_id:
        try:
            if not chat_session_id:
                title = body.message[:50].strip()
                if len(body.message) > 50:
                    title += "..."
                cs = store.create_chat_session(body.session_id, title)
                chat_session_id = cs["id"]
            store.append_chat_message(chat_session_id, "user", body.message)
        except Exception:
            pass  # Don't block the stream on persistence errors

    def generate():
        full_response = ""
        try:
            # Emit chat_session_id early so the frontend can track it immediately
            yield f"data: {json.dumps({'type': 'chat_session', 'chat_session_id': chat_session_id})}\n\n"

            for chunk in agent.chat_stream(message=body.message, session_id=body.session_id, history=history, model=body.model):
                if chunk.get("type") == "text":
                    full_response += chunk.get("content", "")
                    yield f"data: {json.dumps(chunk)}\n\n"
                elif chunk.get("type") == "done":
                    done_data = dict(chunk)
                    done_data["chat_session_id"] = chat_session_id
                    yield f"data: {json.dumps(done_data)}\n\n"
                else:
                    yield f"data: {json.dumps(chunk)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        finally:
            # Save assistant response even if client disconnected mid-stream
            if chat_session_id and full_response.strip():
                try:
                    store.append_chat_message(chat_session_id, "assistant", full_response)
                except Exception:
                    pass

    return StreamingResponse(generate(), media_type="text/event-stream")
