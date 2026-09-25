interface Env {
  TELEMETRY_API_BASE?: string;
  ADMIN_TOKEN?: string;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function pathSegments(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return value.split("/").filter(Boolean);
}

function backendPath(segments: string[]): string | null {
  if (segments.length === 1 && segments[0] === "overview") {
    return "/v1/admin/overview";
  }

  if (segments.length === 1 && segments[0] === "issues") {
    return "/v1/admin/issues";
  }

  if (
    segments.length === 2 &&
    segments[0] === "issues" &&
    /^iss_[a-f0-9]{24}$/.test(segments[1])
  ) {
    return `/v1/admin/issues/${segments[1]}`;
  }

  if (
    segments.length === 2 &&
    segments[0] === "events" &&
    /^[0-9a-f-]{32,36}$/.test(segments[1])
  ) {
    return `/v1/admin/events/${segments[1]}`;
  }

  return null;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const apiBase = context.env.TELEMETRY_API_BASE?.trim();
  const adminToken = context.env.ADMIN_TOKEN?.trim();
  if (!apiBase || !adminToken) {
    return json({ error: "dashboard_not_configured" }, 503);
  }

  const segments = pathSegments(context.params.path as string | string[] | undefined);
  const path = backendPath(segments);
  if (!path) return json({ error: "not_found" }, 404);

  let target: URL;
  try {
    const normalizedBase = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
    target = new URL(path.replace(/^\//, ""), normalizedBase);
  } catch {
    return json({ error: "invalid_api_base" }, 500);
  }

  if (path === "/v1/admin/issues") {
    const incoming = new URL(context.request.url);
    const status = incoming.searchParams.get("status");
    const limit = incoming.searchParams.get("limit");

    if (status === "unresolved" || status === "resolved" || status === "ignored") {
      target.searchParams.set("status", status);
    }

    if (limit && /^\d{1,3}$/.test(limit)) {
      target.searchParams.set("limit", String(Math.min(Number(limit), 100)));
    }
  }

  try {
    const upstream = await fetch(target, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      redirect: "error",
    });

    const headers = new Headers();
    headers.set("content-type", upstream.headers.get("content-type") ?? "application/json");
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    console.error("telemetry dashboard proxy failed", error);
    return json({ error: "upstream_unavailable" }, 502);
  }
};
