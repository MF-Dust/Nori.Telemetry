export type IssueStatus = "unresolved" | "resolved" | "ignored";

export interface Overview {
  window: string;
  events: number;
  terminalEvents: number;
  unresolvedIssues: number;
  affectedInstallations: number;
}

export interface IssueSummary {
  id: string;
  project: string;
  fingerprint: string;
  title: string;
  exception_type: string;
  operation: string;
  first_seen: string;
  last_seen: string;
  event_count: number;
  terminal_count: number;
  affected_installations: number;
  first_release: string;
  last_release: string;
  status: IssueStatus;
}

export interface IssueEvent {
  id: string;
  timestamp: string;
  received_at: string;
  release: string;
  environment: string;
  runtime_name: string;
  runtime_version?: string | null;
  os: string;
  architecture: string;
  session_type?: string | null;
  operation: string;
  handled: number | boolean;
  terminal: number | boolean;
  exception_type: string;
  top_frame?: string | null;
  archived: number | boolean;
}

export interface IssueDetailResponse {
  issue: IssueSummary;
  events: IssueEvent[];
}

export interface IssueListResponse {
  issues: IssueSummary[];
}

export type ArchivedEventPayload = Record<string, unknown>;
