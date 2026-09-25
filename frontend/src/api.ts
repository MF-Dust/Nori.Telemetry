import type {
  ArchivedEventPayload,
  IssueDetailResponse,
  IssueListResponse,
  IssueStatus,
  Overview,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin",
  });

  if (!response.ok) {
    let code: string | undefined;
    let message = `Request failed with HTTP ${response.status}`;

    try {
      const body = (await response.json()) as { error?: string; message?: string };
      code = body.error;
      if (body.message) message = body.message;
      else if (body.error) message = body.error;
    } catch {
      // Keep the generic HTTP message when the response is not JSON.
    }

    throw new ApiError(message, response.status, code);
  }

  return (await response.json()) as T;
}

export function getOverview(): Promise<Overview> {
  return requestJson<Overview>("/api/overview");
}

export function getIssues(status: IssueStatus): Promise<IssueListResponse> {
  const params = new URLSearchParams({ status, limit: "100" });
  return requestJson<IssueListResponse>(`/api/issues?${params}`);
}

export function getIssue(issueId: string): Promise<IssueDetailResponse> {
  return requestJson<IssueDetailResponse>(`/api/issues/${encodeURIComponent(issueId)}`);
}

export function getArchivedEvent(eventId: string): Promise<ArchivedEventPayload> {
  return requestJson<ArchivedEventPayload>(`/api/events/${encodeURIComponent(eventId)}`);
}
