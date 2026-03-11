"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiFetch } from "../config/api";
import { useAuth } from "../contexts/AuthContext";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  sessionId?: string;
  activeChatSessionId: string | null;
  onChatSessionIdChange: (id: string | null) => void;
}

const MODEL_STORAGE_KEY = "rllm_chat_model";
const MAX_TEXTAREA_HEIGHT = 200;

const MODEL_OPTIONS = [
  { label: "Haiku 4.5", value: "claude-haiku-4-5-20251001" },
  { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
  { label: "Opus 4.6", value: "claude-opus-4-6" },
] as const;

export const ChatPanel: React.FC<ChatPanelProps> = ({
  sessionId,
  activeChatSessionId,
  onChatSessionIdChange,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(
    () => localStorage.getItem(MODEL_STORAGE_KEY) || MODEL_OPTIONS[1].value
  );
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<"missing" | "invalid" | null>(null);
  const [currentTool, setCurrentTool] = useState<string | null>(null);

  const { config } = useAuth();
  const router = useRouter();
  const isCloud = config?.auth_required ?? false;

  /** Detect API-key-related errors and return a category, or null. */
  const detectApiKeyError = (msg: string): "missing" | "invalid" | null => {
    if (!isCloud) return null;
    if (/authentication_error|invalid.*api.?key|invalid x-api-key/i.test(msg))
      return "invalid";
    return null;
  };

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const wasUsingToolRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  // Load messages when activeChatSessionId changes
  useEffect(() => {
    if (!activeChatSessionId) {
      setMessages([]);
      return;
    }
    // Skip reload while streaming — the activeChatSessionId changes mid-stream
    // when the backend auto-creates a session, and reloading would clobber the
    // in-progress messages (assistant response isn't persisted until stream ends).
    if (isLoading) return;
    let cancelled = false;
    const loadMessages = async () => {
      try {
        const res = await apiFetch(
          `/api/agent/sessions/${activeChatSessionId}/messages`
        );
        if (!res.ok) throw new Error("Failed to load messages");
        const data = await res.json();
        if (!cancelled) {
          setMessages(
            data.map((m: { role: string; content: string }) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            }))
          );
        }
      } catch {
        if (!cancelled) setMessages([]);
      }
    };
    loadMessages();
    return () => {
      cancelled = true;
    };
  }, [activeChatSessionId]);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;

    // Ignore scroll events caused by our own programmatic scrollTo
    if (programmaticScrollRef.current) return;

    const scrollTop = el.scrollTop;
    const scrolledUp = scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;

    if (scrolledUp) {
      // User scrolled up — disengage auto-scroll
      userScrolledUpRef.current = true;
    }

    // Re-engage if user scrolls back to near bottom
    const distFromBottom = el.scrollHeight - scrollTop - el.clientHeight;
    if (distFromBottom < 40) {
      userScrolledUpRef.current = false;
    }
  };

  useEffect(() => {
    if (!userScrolledUpRef.current) {
      const el = scrollContainerRef.current;
      if (el) {
        programmaticScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
        // Clear the flag after the scroll event fires
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
          lastScrollTopRef.current = el.scrollTop;
        });
      }
    }
  }, [messages]);

  // Note: We intentionally do NOT abort the stream on unmount.
  // The ChatPanel can unmount when the user switches tabs, but the stream
  // should continue so the response is saved. Messages reload from the API
  // when the component remounts.

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT) + "px";
    ta.style.overflowY = ta.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  // Close model menu on outside click
  useEffect(() => {
    if (!showModelMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showModelMenu]);

  const handleModelChange = (value: string) => {
    setSelectedModel(value);
    localStorage.setItem(MODEL_STORAGE_KEY, value);
    setShowModelMenu(false);
  };

  const selectedModelLabel = MODEL_OPTIONS.find((m) => m.value === selectedModel)?.label ?? "Sonnet";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    userScrolledUpRef.current = false;
    const userMessage: ChatMessage = { role: "user", content: input.trim() };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setError(null);
    setApiKeyError(null);
    setCurrentTool(null);
    wasUsingToolRef.current = false;

    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      // Build history from existing messages (exclude empty assistant messages)
      const history = messages
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));

      const response = await apiFetch(
        "/api/agent/chat/stream",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: userMessage.content,
            session_id: sessionId,
            chat_session_id: activeChatSessionId || undefined,
            history: history.length > 0 ? history : undefined,
            model: selectedModel,
          }),
          signal: abortController.signal,
        }
      );

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const detail = err.detail || `HTTP ${response.status}`;
        if (response.status === 503 && isCloud && detail.includes("API key")) {
          setApiKeyError("missing");
        } else {
          const keyErr = detectApiKeyError(detail);
          if (keyErr) setApiKeyError(keyErr);
        }
        throw new Error(detail);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine.startsWith("data: ")) continue;
          const data = trimmedLine.slice(6);
          if (!data) continue;

          try {
            const parsed = JSON.parse(data);

            if (parsed.type === "chat_session") {
              // Backend sends this early so we can track the session immediately
              if (parsed.chat_session_id && parsed.chat_session_id !== activeChatSessionId) {
                onChatSessionIdChange(parsed.chat_session_id);
              }
            } else if (parsed.type === "tool_call") {
              setCurrentTool(parsed.tool);
              wasUsingToolRef.current = true;
            } else if (parsed.type === "text") {
              setCurrentTool(null);
              const prefix = wasUsingToolRef.current ? "\n\n" : "";
              wasUsingToolRef.current = false;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                  updated[updated.length - 1] = {
                    ...last,
                    content: last.content + prefix + parsed.content,
                  };
                }
                return updated;
              });
            } else if (parsed.type === "done") {
              // Update chat session ID if auto-created by backend
              if (parsed.chat_session_id && parsed.chat_session_id !== activeChatSessionId) {
                onChatSessionIdChange(parsed.chat_session_id);
              }
            } else if (parsed.type === "error") {
              const keyErr = detectApiKeyError(parsed.message || "");
              if (keyErr) setApiKeyError(keyErr);
              setError(parsed.message);
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant" && !last.content) {
                  return prev.slice(0, -1);
                }
                return prev;
              });
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;

      const errMsg = err instanceof Error ? err.message : "Failed to send message";
      const keyErr = detectApiKeyError(errMsg);
      if (keyErr) setApiKeyError(keyErr);
      setError(errMsg);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && !last.content) {
          return prev.slice(0, -1);
        }
        return prev;
      });
    } finally {
      setIsLoading(false);
      setCurrentTool(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Messages - Scrollable */}
      <div ref={scrollContainerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto' }} className="p-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-12 h-12 bg-layer-2 rounded-full flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-900">No messages yet</p>
          </div>
        )}

        {messages.map((msg, index) => (
          <div
            key={index}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {msg.role === "user" ? (
              <div className="max-w-[85%] px-3 py-2 rounded-lg bg-accent-600 text-white">
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              </div>
            ) : (
              <div className="w-[90%] prose prose-sm max-w-none text-gray-900">
                {msg.content ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                ) : isLoading && index === messages.length - 1 ? (
                  <div className="flex items-center gap-2 text-gray-500 not-prose">
                    <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" />
                    <span>Thinking...</span>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ))}

        {currentTool && (
          <div className="flex justify-start">
            <div className="bg-accent-50 border border-accent-200 px-3 py-2 rounded-lg">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-accent-500 rounded-full animate-pulse" />
                <span className="text-sm text-accent-700">
                  Calling {currentTool}...
                </span>
              </div>
            </div>
          </div>
        )}

        {apiKeyError && (
          <div className="bg-red-50 border border-red-300 px-4 py-3 rounded-lg">
            <div className="flex items-start gap-2">
              <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-red-800">
                  {apiKeyError === "missing"
                    ? "Anthropic API key not configured"
                    : "Anthropic API key is invalid"}
                </p>
                <p className="text-sm text-red-600 mt-0.5">
                  {apiKeyError === "missing"
                    ? "To use the agent, add your Anthropic API key in "
                    : "Check or update your Anthropic API key in "}
                  <button
                    onClick={() => router.push("/settings")}
                    className="underline font-medium hover:text-red-800"
                  >
                    Settings
                  </button>.
                </p>
              </div>
            </div>
          </div>
        )}

        {error && !apiKeyError && (
          <div className="bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

      </div>

      {/* Input - Fixed at bottom */}
      <form
        onSubmit={handleSubmit}
        className="px-3 pb-3 pt-2 border-t border-gray-200 shrink-0"
      >
        <div className="border border-gray-200 rounded-xl bg-white focus-within:ring-2 focus-within:ring-accent-500 focus-within:border-transparent transition-shadow">
          {/* Textarea row */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your training run..."
            rows={1}
            className="w-full resize-none px-3 pt-2.5 pb-1 text-sm bg-transparent focus:outline-none"
            style={{ overflowY: "hidden" }}
            disabled={isLoading}
          />
          {/* Bottom bar: model selector + send button */}
          <div className="flex items-center justify-between px-2 pb-2">
            {/* Model selector */}
            <div ref={modelMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setShowModelMenu((v) => !v)}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
              >
                {selectedModelLabel}
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showModelMenu && (
                <div className="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-elevated py-1 min-w-[140px] z-10">
                  {MODEL_OPTIONS.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => handleModelChange(m.value)}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                        m.value === selectedModel
                          ? "bg-accent-50 text-accent-700 font-medium"
                          : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Send button */}
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="p-1.5 rounded-lg bg-accent-600 text-white hover:bg-accent-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
