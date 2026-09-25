export const SAFE_TAG_KEYS = new Set([
  "operation",
  "provider",
  "failure_kind",
  "plugin_id",
  "plugin_version",
  "host_api",
  "exception_kind",
  "hresult",
  "assembly",
  "type_name",
]);

export interface TelemetryFrame {
  module?: string;
  function?: string;
  file?: string;
  line?: number;
  column?: number;
  inApp?: boolean;
}

export interface NormalizedTelemetryEvent {
  schemaVersion: 1;
  eventId: string;
  receivedAt: string;
  timestamp: string;
  project: string;
  release: string;
  environment: string;
  runtime: {
    name: string;
    version?: string;
  };
  device: {
    os: string;
    architecture: string;
    sessionType?: string;
  };
  installationHash?: string;
  operation: string;
  handled: boolean;
  terminal: boolean;
  exception: {
    type: string;
    frames: TelemetryFrame[];
  };
  tags: Record<string, string>;
}

export interface IngestConfig {
  INGEST_PROJECT?: string;
  ENVIRONMENT?: string;
}

export interface Env extends IngestConfig {
  DB: D1Database;
  EVENTS: R2Bucket;
  EVENT_QUEUE: Queue<NormalizedTelemetryEvent>;
  MAX_EVENT_BYTES?: string;
  ADMIN_TOKEN?: string;
}
