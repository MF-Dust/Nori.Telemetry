import type { NormalizedTelemetryEvent, TelemetryFrame } from "./types";

export function selectTopFrame(frames: TelemetryFrame[]): TelemetryFrame | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (frames[index]?.inApp) return frames[index];
  }
  return frames.at(-1);
}

export function topFrameLabel(event: NormalizedTelemetryEvent): string {
  const frame = selectTopFrame(event.exception.frames);
  if (!frame) return "";
  return [frame.module, frame.function, frame.file].filter(Boolean).join(":").slice(0, 320);
}

export async function fingerprintEvent(event: NormalizedTelemetryEvent): Promise<string> {
  const frame = selectTopFrame(event.exception.frames);
  const material = [
    event.project,
    event.exception.type,
    event.operation,
    frame?.module ?? "",
    frame?.function ?? "",
    frame?.file ?? "",
  ].join("\n");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function issueIdFromFingerprint(fingerprint: string): string {
  return `iss_${fingerprint.slice(0, 24)}`;
}
