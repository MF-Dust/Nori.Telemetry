import { fingerprintEvent, issueIdFromFingerprint, topFrameLabel } from "./fingerprint";
import type { Env, NormalizedTelemetryEvent } from "./types";

function r2Key(event: NormalizedTelemetryEvent): string {
  const timestamp = new Date(event.timestamp);
  const date = Number.isFinite(timestamp.getTime()) ? timestamp : new Date(event.receivedAt);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `events/${year}/${month}/${day}/${event.eventId}.json`;
}

async function processEvent(event: NormalizedTelemetryEvent, env: Env): Promise<void> {
  const fingerprint = await fingerprintEvent(event);
  const issueId = issueIdFromFingerprint(fingerprint);
  const payloadKey = r2Key(event);
  const topFrame = topFrameLabel(event);
  const now = new Date().toISOString();
  const title = `${event.exception.type} · ${event.operation}`.slice(0, 240);

  await env.EVENTS.put(payloadKey, JSON.stringify({
    ...event,
    issueId,
    fingerprint,
  }), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      project: event.project,
      release: event.release.slice(0, 96),
      issueId,
    },
  });

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO issues (
        id, project, fingerprint, title, exception_type, operation,
        first_seen, last_seen, event_count, terminal_count, affected_installations,
        first_release, last_release, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 'unresolved', ?, ?)`,
    ).bind(
      issueId,
      event.project,
      fingerprint,
      title,
      event.exception.type,
      event.operation,
      event.timestamp,
      event.timestamp,
      event.release,
      event.release,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO events (
        id, issue_id, timestamp, received_at, project, release, environment,
        runtime_name, runtime_version, os, architecture, session_type,
        installation_hash, operation, handled, terminal, exception_type,
        top_frame, r2_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      event.eventId,
      issueId,
      event.timestamp,
      event.receivedAt,
      event.project,
      event.release,
      event.environment,
      event.runtime.name,
      event.runtime.version ?? null,
      event.device.os,
      event.device.architecture,
      event.device.sessionType ?? null,
      event.installationHash ?? null,
      event.operation,
      event.handled ? 1 : 0,
      event.terminal ? 1 : 0,
      event.exception.type,
      topFrame || null,
      payloadKey,
      now,
    ),
  ];

  if (event.installationHash) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO issue_installations (issue_id, installation_hash, first_seen, last_seen)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(issue_id, installation_hash) DO UPDATE SET
           first_seen = MIN(issue_installations.first_seen, excluded.first_seen),
           last_seen = MAX(issue_installations.last_seen, excluded.last_seen)`,
      ).bind(issueId, event.installationHash, event.timestamp, event.timestamp),
    );
  }

  statements.push(
    env.DB.prepare(
      `UPDATE issues SET
        first_seen = COALESCE((SELECT MIN(timestamp) FROM events WHERE issue_id = ?), first_seen),
        last_seen = COALESCE((SELECT MAX(timestamp) FROM events WHERE issue_id = ?), last_seen),
        event_count = (SELECT COUNT(*) FROM events WHERE issue_id = ?),
        terminal_count = (SELECT COUNT(*) FROM events WHERE issue_id = ? AND terminal = 1),
        affected_installations = (SELECT COUNT(*) FROM issue_installations WHERE issue_id = ?),
        first_release = COALESCE((SELECT release FROM events WHERE issue_id = ? ORDER BY timestamp ASC, id ASC LIMIT 1), first_release),
        last_release = COALESCE((SELECT release FROM events WHERE issue_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1), last_release),
        updated_at = ?
       WHERE id = ?`,
    ).bind(issueId, issueId, issueId, issueId, issueId, issueId, issueId, now, issueId),
  );

  await env.DB.batch(statements);
}

export async function processBatch(batch: MessageBatch<NormalizedTelemetryEvent>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processEvent(message.body, env);
      message.ack();
    } catch (error) {
      console.error("telemetry queue processing failed", {
        messageId: message.id,
        eventId: message.body?.eventId,
        error,
      });
      message.retry();
    }
  }
}
