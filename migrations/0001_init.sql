PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  exception_type TEXT NOT NULL,
  operation TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  terminal_count INTEGER NOT NULL DEFAULT 0,
  affected_installations INTEGER NOT NULL DEFAULT 0,
  first_release TEXT NOT NULL,
  last_release TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved', 'resolved', 'ignored')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL,
  project TEXT NOT NULL,
  release TEXT NOT NULL,
  environment TEXT NOT NULL,
  runtime_name TEXT NOT NULL,
  runtime_version TEXT,
  os TEXT NOT NULL,
  architecture TEXT NOT NULL,
  session_type TEXT,
  installation_hash TEXT,
  operation TEXT NOT NULL,
  handled INTEGER NOT NULL CHECK (handled IN (0, 1)),
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  exception_type TEXT NOT NULL,
  top_frame TEXT,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_installations (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  installation_hash TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (issue_id, installation_hash)
);

CREATE INDEX IF NOT EXISTS idx_issues_last_seen ON issues(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_issues_status_last_seen ON issues(status, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_events_issue_timestamp ON events(issue_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_release ON events(release);
