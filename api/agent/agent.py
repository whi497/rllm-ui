"""Observability Agent - LLM-powered training analysis assistant."""

import json
import os
from collections.abc import Generator
from dataclasses import dataclass, field

from agent.prompts import SYSTEM_PROMPT, build_session_context
from agent.tools import TOOL_DEFINITIONS, ToolExecutor
from anthropic import Anthropic
from datastore.base import DataStore


@dataclass
class AgentResponse:
    """Response from the agent."""

    message: str
    sources: list[str] = field(default_factory=list)
    error: str | None = None


class ObservabilityAgent:
    """LLM-powered agent for training observability."""

    def __init__(self, datastore: DataStore, model: str = "claude-sonnet-4-6", api_key: str | None = None):
        resolved_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not resolved_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable is required")

        self.client = Anthropic(api_key=resolved_key)
        self.datastore = datastore
        self.model = model
        self.tool_executor = ToolExecutor(datastore)
        self.max_iterations = 10  # Prevent infinite loops

    def _build_context(self, message: str, session_id: str | None = None) -> tuple[str, str, dict | None]:
        """Build system prompt and formatted message with session context."""
        session = None
        if session_id:
            session = self.datastore.get_session(session_id)

        system_prompt = SYSTEM_PROMPT + build_session_context(session)

        # Add session_id hint to user message if provided
        if session_id:
            message = f"[Current session_id: {session_id}]\n\n{message}"

        return system_prompt, message, session

    def chat(self, message: str, session_id: str | None = None, history: list[dict] | None = None, model: str | None = None) -> AgentResponse:
        """Process a user message and return a response.

        Args:
            message: The user's message
            session_id: Optional session ID to scope the conversation
            history: Optional list of previous messages [{"role": "user"|"assistant", "content": "..."}]
            model: Optional model override for this request
        """
        # Build system prompt with session context
        session = None
        if session_id:
            session = self.datastore.get_session(session_id)

        system_prompt = SYSTEM_PROMPT + build_session_context(session)

        # Add session_id hint to user message if provided
        if session_id:
            message = f"[Current session_id: {session_id}]\n\n{message}"

        # Start with history if provided, otherwise empty
        messages = []
        if history:
            messages = [{"role": m["role"], "content": m["content"]} for m in history]
        messages.append({"role": "user", "content": message})
        sources = []

        # Function calling loop
        for _ in range(self.max_iterations):
            response = self.client.messages.create(
                model=model or self.model,
                max_tokens=4096,
                system=system_prompt,
                tools=TOOL_DEFINITIONS,
                messages=messages,
            )

            # Check if we need to execute tools
            if response.stop_reason == "tool_use":
                # Process tool calls
                tool_results = []
                for block in response.content:
                    if block.type == "tool_use":
                        tool_name = block.name
                        tool_input = block.input

                        # Execute the tool
                        result = self.tool_executor.execute(tool_name, tool_input)
                        sources.append(f"{tool_name}({json.dumps(tool_input)})")

                        tool_results.append(
                            {
                                "type": "tool_result",
                                "tool_use_id": block.id,
                                "content": json.dumps(result),
                            }
                        )

                # Add assistant response and tool results to messages
                messages.append({"role": "assistant", "content": response.content})
                messages.append({"role": "user", "content": tool_results})

            else:
                # No more tool calls, extract final text response
                final_text = ""
                for block in response.content:
                    if hasattr(block, "text"):
                        final_text += block.text

                return AgentResponse(message=final_text, sources=sources)

        # If we hit max iterations, return what we have
        return AgentResponse(
            message="I apologize, but I wasn't able to complete the analysis within the allowed number of steps.",
            sources=sources,
            error="max_iterations_reached",
        )

    def chat_stream(self, message: str, session_id: str | None = None, history: list[dict] | None = None, model: str | None = None) -> Generator[dict, None, None]:
        """Process a user message and stream the response.

        Args:
            message: The user's message
            session_id: Optional session ID to scope the conversation
            history: Optional list of previous messages [{"role": "user"|"assistant", "content": "..."}]
            model: Optional model override for this request
        """
        system_prompt, message, _ = self._build_context(message, session_id)

        # Start with history if provided, otherwise empty
        messages = []
        if history:
            messages = [{"role": m["role"], "content": m["content"]} for m in history]
        messages.append({"role": "user", "content": message})
        sources = []
        streamed_text_parts = []  # Track all text we've streamed

        # Function calling loop
        for iteration in range(self.max_iterations):
            # Use streaming for the API call
            collected_tool_uses = []
            current_tool_use = None
            current_text_block = None
            stop_reason = None
            iteration_text = []  # Text collected in this iteration

            with self.client.messages.stream(
                model=model or self.model,
                max_tokens=4096,
                system=system_prompt,
                tools=TOOL_DEFINITIONS,
                messages=messages,
            ) as stream:
                for event in stream:
                    if event.type == "content_block_start":
                        if event.content_block.type == "tool_use":
                            current_tool_use = {
                                "id": event.content_block.id,
                                "name": event.content_block.name,
                                "input": "",
                            }
                            current_text_block = None
                            yield {
                                "type": "tool_call",
                                "tool": event.content_block.name,
                            }
                        elif event.content_block.type == "text":
                            current_text_block = {"text": ""}
                            current_tool_use = None

                    elif event.type == "content_block_delta":
                        if hasattr(event.delta, "text") and current_text_block is not None:
                            # Stream text content
                            text_chunk = event.delta.text
                            yield {"type": "text", "content": text_chunk}
                            iteration_text.append(text_chunk)
                            current_text_block["text"] += text_chunk
                        elif hasattr(event.delta, "partial_json"):
                            # Accumulate tool input JSON
                            if current_tool_use:
                                current_tool_use["input"] += event.delta.partial_json

                    elif event.type == "content_block_stop":
                        if current_tool_use:
                            # Parse the accumulated JSON input
                            try:
                                tool_input = json.loads(current_tool_use["input"]) if current_tool_use["input"] else {}
                            except json.JSONDecodeError:
                                tool_input = {}
                            collected_tool_uses.append(
                                {
                                    "type": "tool_use",
                                    "id": current_tool_use["id"],
                                    "name": current_tool_use["name"],
                                    "input": tool_input,
                                }
                            )
                            current_tool_use = None
                        current_text_block = None

                    elif event.type == "message_delta":
                        stop_reason = event.delta.stop_reason

                # Get the final message for the conversation history
                final_message = stream.get_final_message()

            # Track what we streamed
            streamed_text_parts.extend(iteration_text)

            # Check if we need to execute tools
            if stop_reason == "tool_use":
                tool_results = []
                for block in collected_tool_uses:
                    # Execute the tool
                    result = self.tool_executor.execute(block["name"], block["input"])
                    sources.append(f"{block['name']}({json.dumps(block['input'])})")

                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block["id"],
                            "content": json.dumps(result),
                        }
                    )

                # Add assistant response and tool results to messages
                messages.append({"role": "assistant", "content": final_message.content})
                messages.append({"role": "user", "content": tool_results})
                # Continue loop to get the final response

            else:
                # No more tool calls, we're done
                yield {"type": "done", "sources": sources}
                return

        # If we hit max iterations
        yield {"type": "error", "message": "Max iterations reached", "sources": sources}
