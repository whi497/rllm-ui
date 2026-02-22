"""Agent router - chat endpoint for the Observability Agent."""

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/agent", tags=["agent"])


class ChatMessage(BaseModel):
    """A single message in the conversation."""

    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    """Request body for chat endpoint."""

    message: str
    session_id: str | None = None
    history: list[ChatMessage] | None = None  # Previous conversation messages
    model: str | None = None  # Override model (e.g. "claude-haiku-4-5-20251001")


class ChatResponse(BaseModel):
    """Response from chat endpoint."""

    message: str
    sources: list[str] = []
    error: str | None = None


@router.post("/chat", response_model=ChatResponse)
def chat(request: Request, body: ChatRequest):
    """Chat with the observability agent.

    Send a natural language message and get insights about your training runs.
    Optionally provide a session_id to focus the conversation on a specific session.
    """
    agent = getattr(request.app.state, "agent", None)
    if agent is None:
        raise HTTPException(
            status_code=503,
            detail="Agent not available. Check that ANTHROPIC_API_KEY is configured.",
        )

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
def chat_stream(request: Request, body: ChatRequest):
    """Stream chat responses from the observability agent.

    Returns Server-Sent Events (SSE) with the following event types:
    - tool_call: {"type": "tool_call", "tool": "tool_name"}
    - text: {"type": "text", "content": "chunk of text"}
    - done: {"type": "done", "sources": ["tool1(...)", "tool2(...)"]}
    - error: {"type": "error", "message": "error message"}
    """
    agent = getattr(request.app.state, "agent", None)
    if agent is None:
        raise HTTPException(
            status_code=503,
            detail="Agent not available. Check that ANTHROPIC_API_KEY is configured.",
        )

    # Convert history to list of dicts if provided
    history = None
    if body.history:
        history = [{"role": m.role, "content": m.content} for m in body.history]

    def generate():
        try:
            for chunk in agent.chat_stream(message=body.message, session_id=body.session_id, history=history, model=body.model):
                yield f"data: {json.dumps(chunk)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
