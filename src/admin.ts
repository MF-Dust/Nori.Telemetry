import type { Env } from "./types";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 && secureEqual(token, env.ADMIN_TOKEN);
}

function safeLimit(url: URL): number {
  const parsed = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 100)) : 50;
}

function resultCount(result: { results?: unknown[] }): number {
  const first = result.results?.[0] as { count?: number } | undefined;
  return Number(first?.count ?? 0);
}

async function overview(env: Env): Promise<Response> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [events24h, terminal24h, unresolved, affected] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp >= ?").bind(since),
    env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp >= ? AND terminal = 1").bind(since),
    env.DB.prepare("SELECT COUNT(*) AS count FROM issues WHERE status = 'unresolved'"),
    env.DB.prepare("SELECT COUNT(DISTINCT installation_hash) AS count FROM events WHERE timestamp >= ? AND installation_hash IS NOT NULL").bind(since),
  ]);

  return json({
    window: "24h",
    events: resultCount(events24h),
    terminalEvents: resultCount(terminal24h),
    unresolvedIssues: resultCount(unresolved),
    affectedInstallations: resultCount(affected),
  });
}

async function listIssues(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = safeLimit(url);
  const status = url.searchParams.get("status");
  const allowedStatus = status === "unresolved" || status === "resolved" || status === "ignored" ? status : undefined;

  const columns = `id, project, fingerprint, title, exception_type, operation, first_seen, last_seen,
    event_count, terminal_count, affected_installations, first_release, last_release, status`;

  const result = allowedStatus
    ? await env.DB.prepare(`SELECT ${columns} FROM issues WHERE status = ? ORDER BY last_seen DESC LIMIT ?`).bind(allowedStatus, limit).all()
    : await env.DB.prepare(`SELECT ${columns} FROM issues ORDER BY last_seen DESC LIMIT ?`).bind(limit).all();

  return json({ issues: result.results ?? [] });
}

async function getIssue(issueId: string, env: Env): Promise<Response> {
  const issue = await env.DB.prepare(
    `SELECT id, project, fingerprint, title, exception_type, operation, first_seen, last_seen,
      event_count, terminal_count, affected_installations, first_release, last_release, status
     FROM issues WHERE id = ?`,
  ).bind(issueId).first();

  if (!issue) return json({ error: "not_found" }, 404);

  const events = await env.DB.prepare(
    `SELECT id, timestamp, received_at, release, environment, runtime_name, runtime_version,
      os, architecture, session_type, operation, handled, terminal, exception_type, top_frame
     FROM events WHERE issue_id = ? ORDER BY timestamp DESC LIMIT 25`,
  ).bind(issueId).all();

  return json({ issue, events: events.results ?? [] });
}

async function getEvent(eventId: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT r2_key FROM events WHERE id = ?").bind(eventId).first<{ r2_key: string }>();
  if (!row) return json({ error: "not_found" }, 404);

  const object = await env.EVENTS.get(row.r2_key);
  if (!object) return json({ error: "payload_missing" }, 404);

  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }

  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(request.url);
  if (url.pathname === "/v1/admin/overview") return overview(env);
  if (url.pathname === "/v1/admin/issues") return listIssues(request, env);

  const issueMatch = /^\/v1\/admin\/issues\/(iss_[a-f0-9]{24})$/.exec(url.pathname);
  if (issueMatch) return getIssue(issueMatch[1], env);

  const eventMatch = /^\/v1\/admin\/events\/([0-9a-f-]{32,36})$/.exec(url.pathname);
  if (eventMatch) return getEvent(eventMatch[1], env);

  return json({ error: "not_found" }, 404);
}
