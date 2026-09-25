import type { Env, NormalizedTelemetryEvent } from "./types";
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

function integerSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function maxEventBytes(env: Env): number {
  return integerSetting(env.MAX_EVENT_BYTES, 65_536, 1_024, 262_144);
}

function stormGuardSeconds(env: Env): number {
  return integerSetting(env.STORM_GUARD_SECONDS, 6, 1, 60);
}

async function blockedByStormGuard(
  request: Request,
  event: NormalizedTelemetryEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<boolean> {
  // No hardware identifier is synthesized. Legacy events without the random installation
  // hash skip this best-effort guard and are still protected by queue batching downstream.
  if (!event.installationHash) return false;

  try {
    const url = new URL(request.url);
    const errorClass = encodeURIComponent(`${event.operation}:${event.exception.type}`);
    url.pathname = `/__nori_telemetry/storm/${event.installationHash}/${errorClass}`;
    url.search = "";
    url.hash = "";

    const key = new Request(url.toString(), { method: "GET" });
    const cache = caches.default;
    if (await cache.match(key)) return true;

    const ttl = stormGuardSeconds(env);
    ctx.waitUntil(cache.put(key, new Response("1", {
      headers: {
        "cache-control": `public, s-maxage=${ttl}`,
        "content-type": "text/plain",
      },
    })));
    return false;
  } catch (error) {
    // Cache API is intentionally fail-open. It is a local-colo circuit breaker,
    // not a correctness or security boundary.
    console.warn("telemetry storm guard unavailable", error);
    return false;
  }
}

export async function ingest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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
    if (await blockedByStormGuard(request, event, env, ctx)) {
      return json({
        error: "rate_limited",
        message: "Telemetry storm guard suppressed this repeated event",
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
