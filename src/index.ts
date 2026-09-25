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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        service: "nori-telemetry",
        status: "ok",
        schemaVersion: 1,
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/events") {
      return ingest(request, env);
    }

    if (url.pathname.startsWith("/v1/admin/")) {
      return handleAdmin(request, env);
    }

    return json({ error: "not_found" }, 404);
  },

  async queue(batch: MessageBatch<NormalizedTelemetryEvent>, env: Env): Promise<void> {
    await processBatch(batch, env);
  },
} satisfies ExportedHandler<Env, NormalizedTelemetryEvent>;
