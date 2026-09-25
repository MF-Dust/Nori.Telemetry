import { SAFE_TAG_KEYS, type IngestConfig, type NormalizedTelemetryEvent, type TelemetryFrame } from "./types";

const MAX_OPERATION = 80;
const MAX_TAG = 64;
const MAX_RELEASE = 96;
const MAX_SYMBOL = 160;
const MAX_FRAMES = 64;

const TOP_LEVEL_FORBIDDEN = new Set([
  "message",
  "user",
  "request",
  "extra",
  "breadcrumbs",
  "contexts",
  "attachments",
]);

const EXCEPTION_FORBIDDEN = new Set(["message", "value"]);

export class ValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function assertNoForbiddenKeys(record: Record<string, unknown>, forbidden: Set<string>): void {
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ValidationError("privacy_field_not_allowed", `Field "${key}" is not accepted by the telemetry protocol`);
    }
  }
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withoutControls = trimmed.replace(/[\u0000-\u001f\u007f]/g, "");
  if (!withoutControls) return undefined;
  return withoutControls.slice(0, max);
}

export function normalizeOperation(value: unknown): string {
  const source = boundedString(value, 256);
  if (!source) return "operation";
  const normalized = [...source]
    .map((character) => /[A-Za-z0-9_.-]/.test(character) ? character : "_")
    .join("")
    .replace(/^_+|_+$/g, "");
  return (normalized || "operation").slice(0, MAX_OPERATION);
}

export function normalizeTag(value: unknown): string {
  const source = boundedString(value, 256);
  if (!source) return "";
  return [...source]
    .map((character) => /[A-Za-z0-9_.-]/.test(character) ? character.toLowerCase() : "_")
    .join("")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_TAG);
}

function normalizeSymbol(value: unknown, fallback = ""): string {
  const source = boundedString(value, 512);
  if (!source) return fallback;
  const normalized = [...source]
    .map((character) => /[A-Za-z0-9_.$+`\[\],-]/.test(character) ? character : "_")
    .join("")
    .replace(/^_+|_+$/g, "");
  return (normalized || fallback).slice(0, MAX_SYMBOL);
}

function normalizeFile(value: unknown): string | undefined {
  const source = boundedString(value, 256);
  if (!source) return undefined;
  if (source.includes("/") || source.includes("\\") || source.includes("://") || /^[A-Za-z]:/.test(source)) {
    return "[path]";
  }
  return normalizeSymbol(source, "file").slice(0, 96);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return Math.min(value, 10_000_000);
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;
  return date.toISOString();
}

function normalizeTags(value: unknown): Record<string, string> {
  const input = asRecord(value);
  if (!input) return {};
  const tags: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = normalizeTag(rawKey);
    const tagValue = normalizeTag(rawValue);
    if (!key || !tagValue || !SAFE_TAG_KEYS.has(key) || Object.hasOwn(tags, key)) continue;
    tags[key] = tagValue;
  }
  return tags;
}

function normalizeFrames(value: unknown): TelemetryFrame[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_FRAMES).flatMap((candidate): TelemetryFrame[] => {
    const input = asRecord(candidate);
    if (!input) return [];

    const frame: TelemetryFrame = {};
    const module = normalizeSymbol(input.module);
    const fn = normalizeSymbol(input.function);
    const file = normalizeFile(input.file);
    const line = normalizePositiveInteger(input.line);
    const column = normalizePositiveInteger(input.column);

    if (module) frame.module = module;
    if (fn) frame.function = fn;
    if (file) frame.file = file;
    if (line) frame.line = line;
    if (column) frame.column = column;
    if (typeof input.inApp === "boolean") frame.inApp = input.inApp;

    return [frame];
  });
}

function normalizeInstallationHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{16,64}$/.test(normalized) ? normalized : undefined;
}

export function normalizeEvent(
  value: unknown,
  config: IngestConfig,
  receivedAt = new Date().toISOString(),
): NormalizedTelemetryEvent {
  const input = asRecord(value);
  if (!input) throw new ValidationError("invalid_body", "Telemetry event must be a JSON object");
  assertNoForbiddenKeys(input, TOP_LEVEL_FORBIDDEN);

  if (input.schemaVersion !== 1) {
    throw new ValidationError("unsupported_schema", "Only telemetry schemaVersion 1 is accepted");
  }

  const exceptionInput = asRecord(input.exception);
  if (!exceptionInput) throw new ValidationError("invalid_exception", "exception is required");
  assertNoForbiddenKeys(exceptionInput, EXCEPTION_FORBIDDEN);

  const exceptionType = normalizeSymbol(exceptionInput.type, "Exception");
  if (!exceptionType) throw new ValidationError("invalid_exception", "exception.type is required");

  const runtimeInput = asRecord(input.runtime) ?? {};
  const deviceInput = asRecord(input.device) ?? {};

  const release = boundedString(input.release, MAX_RELEASE) ?? "Dev";
  const project = normalizeTag(config.INGEST_PROJECT) || "nori-desktop";
  const environment = normalizeTag(input.environment) || normalizeTag(config.ENVIRONMENT) || "production";
  const runtimeName = normalizeTag(runtimeInput.name) || "native";
  const runtimeVersion = boundedString(runtimeInput.version, MAX_TAG);
  const os = normalizeTag(deviceInput.os) || "unknown";
  const architecture = normalizeTag(deviceInput.architecture) || "unknown";
  const sessionType = normalizeTag(deviceInput.sessionType);
  const eventId = typeof input.eventId === "string" && /^[0-9a-fA-F-]{32,36}$/.test(input.eventId.trim())
    ? input.eventId.trim().toLowerCase()
    : crypto.randomUUID();

  return {
    schemaVersion: 1,
    eventId,
    receivedAt,
    timestamp: normalizeTimestamp(input.timestamp, receivedAt),
    project,
    release,
    environment,
    runtime: {
      name: runtimeName,
      ...(runtimeVersion ? { version: runtimeVersion } : {}),
    },
    device: {
      os,
      architecture,
      ...(sessionType ? { sessionType } : {}),
    },
    ...(normalizeInstallationHash(input.installationHash)
      ? { installationHash: normalizeInstallationHash(input.installationHash) }
      : {}),
    operation: normalizeOperation(input.operation),
    handled: typeof input.handled === "boolean" ? input.handled : true,
    terminal: typeof input.terminal === "boolean" ? input.terminal : false,
    exception: {
      type: exceptionType,
      frames: normalizeFrames(exceptionInput.frames),
    },
    tags: normalizeTags(input.tags),
  };
}
