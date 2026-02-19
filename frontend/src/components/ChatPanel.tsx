import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { API_BASE_URL } from "../config/api";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  sessionId?: string;
}

const CHAT_STORAGE_KEY = "rllm_chat_messages_";

export const ChatPanel: React.FC<ChatPanelProps> = ({ sessionId }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const wasUsingToolRef = useRef(false);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    const stored = localStorage.getItem(CHAT_STORAGE_KEY + sessionId);
    if (stored) {
      try {
        setMessages(JSON.parse(stored));
      } catch {
        setMessages([]);
      }
    } else {
      setMessages([]);
    }
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const saveMessages = (msgs: ChatMessage[]) => {
    if (sessionId && msgs.length > 0) {
      const toSave = msgs.filter((m) => m.content.trim());
      localStorage.setItem(
        CHAT_STORAGE_KEY + sessionId,
        JSON.stringify(toSave)
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const userMessage: ChatMessage = { role: "user", content: input.trim() };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setError(null);
    setCurrentTool(null);
    wasUsingToolRef.current = false;

    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      // Build history from existing messages (exclude empty assistant messages)
      const history = messages
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));

      const response = await fetch(
        `${API_BASE_URL}/api/agent/chat/stream`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: userMessage.content,
            session_id: sessionId,
            history: history.length > 0 ? history : undefined,
          }),
          signal: abortController.signal,
        }
      );

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        console.log("Stream read:", { done, valueLength: value?.length });
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        console.log("Buffer:", buffer);
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        console.log("Lines to process:", lines);

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine.startsWith("data: ")) continue;
          const data = trimmedLine.slice(6);
          if (!data) continue;

          try {
            const parsed = JSON.parse(data);
            console.log("Parsed event:", parsed);

            if (parsed.type === "tool_call") {
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
              setMessages((prev) => {
                saveMessages(prev);
                return prev;
              });
            } else if (parsed.type === "error") {
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

      setMessages((prev) => {
        saveMessages(prev);
        return prev;
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;

      setError(err instanceof Error ? err.message : "Failed to send message");
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
      <div style={{ flex: 1, overflowY: 'auto' }} className="p-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-3">
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
            <div
              className={`max-w-[85%] px-3 py-2 rounded-lg ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              {msg.role === "user" ? (
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              ) : (
                <div className="text-sm">
                  {msg.content ? (
                    <ReactMarkdown
                      components={{
                        h1: ({ children }) => (
                          <h1 className="text-base font-semibold mt-3 mb-1.5">
                            {children}
                          </h1>
                        ),
                        h2: ({ children }) => (
                          <h2 className="text-sm font-semibold mt-2.5 mb-1">
                            {children}
                          </h2>
                        ),
                        h3: ({ children }) => (
                          <h3 className="text-sm font-medium mt-2 mb-1">
                            {children}
                          </h3>
                        ),
                        p: ({ children }) => (
                          <p className="my-1">{children}</p>
                        ),
                        ul: ({ children }) => (
                          <ul className="my-1 ml-4 list-disc">{children}</ul>
                        ),
                        ol: ({ children }) => (
                          <ol className="my-1 ml-4 list-decimal">
                            {children}
                          </ol>
                        ),
                        li: ({ children }) => <li className="my-0.5">{children}</li>,
                        code: ({ className, children }) => {
                          const isBlock = className?.includes("language-");
                          return isBlock ? (
                            <code className={className}>{children}</code>
                          ) : (
                            <code className="bg-gray-200 text-pink-600 px-1 py-0.5 rounded text-xs font-mono">
                              {children}
                            </code>
                          );
                        },
                        pre: ({ children }) => (
                          <pre className="bg-gray-900 text-gray-100 p-3 my-2 rounded-md overflow-x-auto text-xs font-mono">
                            {children}
                          </pre>
                        ),
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  ) : isLoading && index === messages.length - 1 ? (
                    <div className="flex items-center gap-2 text-gray-500">
                      <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" />
                      <span>Thinking...</span>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Tool indicator */}
        {currentTool && (
          <div className="flex justify-start">
            <div className="bg-blue-50 border border-blue-200 px-3 py-2 rounded-lg">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                <span className="text-sm text-blue-700">
                  Calling {currentTool}...
                </span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input - Fixed at bottom */}
      <form
        onSubmit={handleSubmit}
        className="p-3 border-t border-gray-100 shrink-0"
      >
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your training run..."
            rows={1}
            className="flex-1 resize-none border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
};
