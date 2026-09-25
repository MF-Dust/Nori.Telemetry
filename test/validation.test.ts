import { describe, expect, it } from "vitest";
import { normalizeEvent, normalizeOperation, ValidationError } from "../src/validation";

describe("telemetry validation", () => {
  it("matches Nori.Desktop operation normalization", () => {
    expect(normalizeOperation("bridge.chat_start/用户消息")).toBe("bridge.chat_start");
    expect(normalizeOperation("中文操作")).toBe("operation");
  });

  it("accepts a scrubbed event and scrubs file paths again", () => {
    const event = normalizeEvent({
      schemaVersion: 1,
      release: "1.2.3",
      operation: "bridge.invoke",
      runtime: { name: "native", version: ".NET 10" },
      device: { os: "Windows", architecture: "x64", sessionType: "windows" },
      installationHash: "0123456789abcdef0123456789abcdef",
      handled: false,
      terminal: true,
      exception: {
        type: "System.InvalidOperationException",
        frames: [
          {
            module: "Nori.Desktop",
            function: "Run",
            file: "C:\\Users\\someone\\Nori\\App.cs",
            line: 42,
            inApp: true,
          },
        ],
      },
      tags: {
        failure_kind: "plugin_load",
        unsafe_user_text: "must-not-pass",
      },
    }, {
      INGEST_PROJECT: "nori-desktop",
      ENVIRONMENT: "production",
    }, "2026-09-25T10:00:00.000Z");

    expect(event.exception.frames[0]?.file).toBe("[path]");
    expect(event.tags).toEqual({ failure_kind: "plugin_load" });
    expect(event.device.os).toBe("windows");
    expect(event.installationHash).toBe("0123456789abcdef0123456789abcdef");
  });

  it("rejects exception messages at the protocol boundary", () => {
    expect(() => normalizeEvent({
      schemaVersion: 1,
      exception: {
        type: "System.Exception",
        message: "may contain user content",
      },
    }, {})).toThrowError(ValidationError);
  });
});
