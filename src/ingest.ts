import type { Env } from "./types";
import { normalizeEvent, ValidationError } from "./validation";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function maxEventBytes(env: Env): number {
  const parsed = Number.parseInt(env.MAX_EVENT_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1024 ? Math.min(parsed, 262_144) : 65_536;
}

export async function ingest(request: Request, env: Env): Promise<Response> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "content_type", message: "Content-Type must be application/json" }, 415);
  }

  const maxBytes = maxEventBytes(env);
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return json({ error: "payload_too_large" }, 413);
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) return json({ error: "payload_too_large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  try {
    const event = normalizeEvent(body, env);

    // installationHash is preferred because it is stable without exposing a real device identifier.
    // Anonymous/legacy clients intentionally share a conservative bucket per Cloudflare location.
    const limitKey = event.installationHash ? `install:${event.installationHash}` : "anonymous";
    const { success } = await env.INGEST_RATE_LIMITER.limit({ key: limitKey });
    if (!success) {
      return json({
        error: "rate_limited",
        message: "Too many telemetry events from this installation",
      }, 429);
    }

    await env.EVENT_QUEUE.send(event);
    return json({ accepted: true, eventId: event.eventId }, 202);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.code, message: error.message }, 400);
    }
    console.error("telemetry ingestion failed", error);
    return json({ error: "ingest_failed" }, 503);
  }
}
