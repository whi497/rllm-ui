import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const backendUrl = process.env.BACKEND_URL || "http://localhost:8000";
  const body = await req.text();

  const backendRes = await fetch(`${backendUrl}/api/agent/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(req.headers.get("cookie")
        ? { cookie: req.headers.get("cookie")! }
        : {}),
    },
    body,
  });

  if (!backendRes.ok || !backendRes.body) {
    const text = await backendRes.text();
    return new Response(text, {
      status: backendRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Re-stream the response without buffering
  return new Response(backendRes.body, {
    status: backendRes.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
