import { handleAdmin } from "./admin";
import { ingest } from "./ingest";
import { processBatch } from "./processor";
import type { Env, NormalizedTelemetryEvent } from "./types";

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

async function pruneOldEvents(env: Env): Promise<void> {
  const retentionDays = integerSetting(env.EVENT_RETENTION_DAYS, 30, 7, 180);
  const deleteLimit = integerSetting(env.MAINTENANCE_DELETE_LIMIT, 2_000, 100, 5_000);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await env.DB.prepare(
    `DELETE FROM events
     WHERE id IN (
       SELECT id FROM events
       WHERE timestamp < ?
       ORDER BY timestamp ASC
       LIMIT ?
     )`,
  ).bind(cutoff, deleteLimit).run();

  console.log("telemetry retention cleanup", {
    retentionDays,
    deleteLimit,
    deleted: Number(result.meta?.changes ?? 0),
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        service: "nori-telemetry",
        status: "ok",
        schemaVersion: 1,
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/events") {
      return ingest(request, env, ctx);
    }

    if (url.pathname.startsWith("/v1/admin/")) {
      return handleAdmin(request, env);
    }

    return json({ error: "not_found" }, 404);
  },

  async queue(batch: MessageBatch<NormalizedTelemetryEvent>, env: Env): Promise<void> {
    await processBatch(batch, env);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await pruneOldEvents(env);
  },
} satisfies ExportedHandler<Env, NormalizedTelemetryEvent>;
