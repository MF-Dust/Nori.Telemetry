import { fingerprintEvent, issueIdFromFingerprint, topFrameLabel } from "./fingerprint";
import type { Env, NormalizedTelemetryEvent } from "./types";

interface PreparedEvent {
  message: Message<NormalizedTelemetryEvent>;
  event: NormalizedTelemetryEvent;
  fingerprint: string;
  issueId: string;
  topFrame: string;
}

function r2Key(event: NormalizedTelemetryEvent): string {
  const timestamp = new Date(event.timestamp);
  const date = Number.isFinite(timestamp.getTime()) ? timestamp : new Date(event.receivedAt);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `events/${year}/${month}/${day}/${event.eventId}.json`;
}

function changes(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0);
}

function archiveTerminalEvents(env: Env): boolean {
  const value = (env.ARCHIVE_TERMINAL_EVENTS ?? "1").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

async function archiveEvent(item: PreparedEvent, env: Env): Promise<string | null> {
  const payloadKey = r2Key(item.event);
  try {
    await env.EVENTS.put(payloadKey, JSON.stringify({
      ...item.event,
      issueId: item.issueId,
      fingerprint: item.fingerprint,
    }), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        project: item.event.project,
        release: item.event.release.slice(0, 96),
        issueId: item.issueId,
      },
    });
    return payloadKey;
  } catch (error) {
    // R2 is diagnostic enrichment. Losing one archived payload must not cause Queue retries
    // that would spend more D1/R2 quota or block aggregate issue statistics.
    console.error("telemetry R2 archive failed", {
      eventId: item.event.eventId,
      issueId: item.issueId,
      error,
    });
    return null;
  }
}

async function processIssueGroup(items: PreparedEvent[], env: Env): Promise<void> {
  const representative = items[0];
  const now = new Date().toISOString();
  const title = `${representative.event.exception.type} · ${representative.event.operation}`.slice(0, 240);

  const issueInsert = await env.DB.prepare(
    `INSERT OR IGNORE INTO issues (
      id, project, fingerprint, title, exception_type, operation,
      first_seen, last_seen, event_count, terminal_count, affected_installations,
      first_release, last_release, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 'unresolved', ?, ?)`,
  ).bind(
    representative.issueId,
    representative.event.project,
    representative.fingerprint,
    title,
    representative.event.exception.type,
    representative.event.operation,
    representative.event.timestamp,
    representative.event.timestamp,
    representative.event.release,
    representative.event.release,
    now,
    now,
  ).run();

  const isNewIssue = changes(issueInsert) > 0;

  const statements: D1PreparedStatement[] = [];
  const descriptors: Array<{ kind: "event" | "installation"; item: PreparedEvent }> = [];

  for (const item of items) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO events (
          id, issue_id, timestamp, received_at, project, release, environment,
          runtime_name, runtime_version, os, architecture, session_type,
          installation_hash, operation, handled, terminal, exception_type,
          top_frame, r2_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
      ).bind(
        item.event.eventId,
        item.issueId,
        item.event.timestamp,
        item.event.receivedAt,
        item.event.project,
        item.event.release,
        item.event.environment,
        item.event.runtime.name,
        item.event.runtime.version ?? null,
        item.event.device.os,
        item.event.device.architecture,
        item.event.device.sessionType ?? null,
        item.event.installationHash ?? null,
        item.event.operation,
        item.event.handled ? 1 : 0,
        item.event.terminal ? 1 : 0,
        item.event.exception.type,
        item.topFrame || null,
        now,
      ),
    );
    descriptors.push({ kind: "event", item });

    if (item.event.installationHash) {
      // Only the first sighting of an installation for an issue writes a row.
      // Repeated errors no longer rewrite last_seen on every occurrence.
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO issue_installations (
            issue_id, installation_hash, first_seen, last_seen
          ) VALUES (?, ?, ?, ?)`,
        ).bind(
          item.issueId,
          item.event.installationHash,
          item.event.timestamp,
          item.event.timestamp,
        ),
      );
      descriptors.push({ kind: "installation", item });
    }
  }

  const results = statements.length > 0 ? await env.DB.batch(statements) : [];
  const insertedEvents: PreparedEvent[] = [];
  let newInstallations = 0;

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    if (changes(results[index]) <= 0) continue;
    if (descriptor.kind === "event") insertedEvents.push(descriptor.item);
    else newInstallations += 1;
  }

  if (insertedEvents.length > 0) {
    const ordered = [...insertedEvents].sort((left, right) =>
      left.event.timestamp.localeCompare(right.event.timestamp) || left.event.eventId.localeCompare(right.event.eventId)
    );
    const earliest = ordered[0].event;
    const latest = ordered.at(-1)!.event;
    const terminalCount = insertedEvents.reduce((count, item) => count + (item.event.terminal ? 1 : 0), 0);

    await env.DB.prepare(
      `UPDATE issues SET
        event_count = event_count + ?,
        terminal_count = terminal_count + ?,
        affected_installations = affected_installations + ?,
        first_release = CASE WHEN ? < first_seen THEN ? ELSE first_release END,
        last_release = CASE WHEN ? >= last_seen THEN ? ELSE last_release END,
        first_seen = CASE WHEN ? < first_seen THEN ? ELSE first_seen END,
        last_seen = CASE WHEN ? > last_seen THEN ? ELSE last_seen END,
        updated_at = ?
       WHERE id = ?`,
    ).bind(
      insertedEvents.length,
      terminalCount,
      newInstallations,
      earliest.timestamp,
      earliest.release,
      latest.timestamp,
      latest.release,
      earliest.timestamp,
      earliest.timestamp,
      latest.timestamp,
      latest.timestamp,
      now,
      representative.issueId,
    ).run();
  } else if (newInstallations > 0) {
    // Repairs a rare partial retry without rescanning issue_installations.
    await env.DB.prepare(
      "UPDATE issues SET affected_installations = affected_installations + ?, updated_at = ? WHERE id = ?",
    ).bind(newInstallations, now, representative.issueId).run();
  }

  if (insertedEvents.length === 0) return;

  // R2 is deliberately sparse: keep one representative payload for a brand-new issue,
  // plus terminal events when enabled. Routine duplicates remain D1-only.
  const archiveIds = new Set<string>();
  if (isNewIssue) archiveIds.add(insertedEvents[0].event.eventId);
  if (archiveTerminalEvents(env)) {
    for (const item of insertedEvents) {
      if (item.event.terminal) archiveIds.add(item.event.eventId);
    }
  }

  const archived: Array<{ eventId: string; key: string }> = [];
  for (const item of insertedEvents) {
    if (!archiveIds.has(item.event.eventId)) continue;
    const key = await archiveEvent(item, env);
    if (key) archived.push({ eventId: item.event.eventId, key });
  }

  if (archived.length > 0) {
    await env.DB.batch(archived.map(({ eventId, key }) =>
      env.DB.prepare("UPDATE events SET r2_key = ? WHERE id = ?").bind(key, eventId)
    ));
  }
}

export async function processBatch(batch: MessageBatch<NormalizedTelemetryEvent>, env: Env): Promise<void> {
  const prepared = await Promise.all(batch.messages.map(async (message): Promise<PreparedEvent> => {
    const event = message.body;
    const fingerprint = await fingerprintEvent(event);
    return {
      message,
      event,
      fingerprint,
      issueId: issueIdFromFingerprint(fingerprint),
      topFrame: topFrameLabel(event),
    };
  }));

  const groups = new Map<string, PreparedEvent[]>();
  for (const item of prepared) {
    const group = groups.get(item.issueId);
    if (group) group.push(item);
    else groups.set(item.issueId, [item]);
  }

  for (const items of groups.values()) {
    try {
      await processIssueGroup(items, env);
      for (const item of items) item.message.ack();
    } catch (error) {
      console.error("telemetry queue processing failed", {
        issueId: items[0]?.issueId,
        eventIds: items.map((item) => item.event.eventId),
        error,
      });
      for (const item of items) item.message.retry();
    }
  }
}
