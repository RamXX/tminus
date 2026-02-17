/**
 * Unit tests for funnel event instrumentation (TM-zf91.6).
 *
 * Covers: event emission, sink abstraction, configuration parsing,
 * stage validation, enable/disable toggling, and composite sinks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FUNNEL_STAGES,
  FunnelEmitter,
  MemoryEventSink,
  ConsoleEventSink,
  CompositeEventSink,
  NoopEventSink,
  parseFunnelConfig,
  createFunnelEmitter,
  isValidFunnelStage,
  getFunnelStageIndex,
  getNextFunnelStage,
  DEFAULT_FUNNEL_CONFIG,
  type FunnelStage,
  type FunnelConfig,
  type FunnelEvent,
} from "./funnel-events";

describe("funnel-events", () => {
  // -----------------------------------------------------------------------
  // FUNNEL_STAGES constant
  // -----------------------------------------------------------------------
  describe("FUNNEL_STAGES", () => {
    it("defines exactly 5 ordered stages", () => {
      expect(FUNNEL_STAGES).toHaveLength(5);
      expect(FUNNEL_STAGES).toEqual([
        "landing_cta_click",
        "signup_start",
        "first_provider_connect",
        "first_sync_complete",
        "first_insight_viewed",
      ]);
    });

    it("stages are in conversion funnel order", () => {
      // Verify ordering: each stage should come after its predecessor
      const stageNames = [...FUNNEL_STAGES];
      expect(stageNames[0]).toBe("landing_cta_click");
      expect(stageNames[4]).toBe("first_insight_viewed");
    });
  });

  // -----------------------------------------------------------------------
  // MemoryEventSink
  // -----------------------------------------------------------------------
  describe("MemoryEventSink", () => {
    let sink: MemoryEventSink;

    beforeEach(() => {
      sink = new MemoryEventSink();
    });

    it("accumulates events in order", async () => {
      const event1: FunnelEvent = {
        stage: "landing_cta_click",
        userId: "u1",
        timestamp: "2026-01-01T00:00:00Z",
      };
      const event2: FunnelEvent = {
        stage: "signup_start",
        userId: "u1",
        timestamp: "2026-01-01T00:01:00Z",
      };

      await sink.write(event1);
      await sink.write(event2);

      expect(sink.events).toHaveLength(2);
      expect(sink.events[0].stage).toBe("landing_cta_click");
      expect(sink.events[1].stage).toBe("signup_start");
    });

    it("clear() empties accumulated events", async () => {
      await sink.write({
        stage: "landing_cta_click",
        userId: "u1",
        timestamp: "2026-01-01T00:00:00Z",
      });

      expect(sink.events).toHaveLength(1);
      sink.clear();
      expect(sink.events).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // ConsoleEventSink
  // -----------------------------------------------------------------------
  describe("ConsoleEventSink", () => {
    it("writes event as JSON to console.log", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const sink = new ConsoleEventSink();

      await sink.write({
        stage: "signup_start",
        userId: "u42",
        timestamp: "2026-02-01T12:00:00Z",
      });

      expect(consoleSpy).toHaveBeenCalledOnce();
      const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logged._type).toBe("funnel_event");
      expect(logged.stage).toBe("signup_start");
      expect(logged.userId).toBe("u42");

      consoleSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // CompositeEventSink
  // -----------------------------------------------------------------------
  describe("CompositeEventSink", () => {
    it("writes to all inner sinks", async () => {
      const sinkA = new MemoryEventSink();
      const sinkB = new MemoryEventSink();
      const composite = new CompositeEventSink([sinkA, sinkB]);

      await composite.write({
        stage: "first_provider_connect",
        userId: "u1",
        timestamp: "2026-01-01T00:00:00Z",
      });

      expect(sinkA.events).toHaveLength(1);
      expect(sinkB.events).toHaveLength(1);
      expect(sinkA.events[0].stage).toBe("first_provider_connect");
    });
  });

  // -----------------------------------------------------------------------
  // NoopEventSink
  // -----------------------------------------------------------------------
  describe("NoopEventSink", () => {
    it("silently discards events", async () => {
      const sink = new NoopEventSink();
      // Should not throw
      await sink.write({
        stage: "landing_cta_click",
        userId: "u1",
        timestamp: "2026-01-01T00:00:00Z",
      });
    });
  });

  // -----------------------------------------------------------------------
  // FunnelEmitter
  // -----------------------------------------------------------------------
  describe("FunnelEmitter", () => {
    let sink: MemoryEventSink;
    let emitter: FunnelEmitter;

    beforeEach(() => {
      sink = new MemoryEventSink();
      emitter = new FunnelEmitter(sink);
    });

    it("emits events with correct stage and userId", async () => {
      const result = await emitter.emit("landing_cta_click", "user-abc");

      expect(result).not.toBeNull();
      expect(result!.stage).toBe("landing_cta_click");
      expect(result!.userId).toBe("user-abc");
      expect(sink.events).toHaveLength(1);
    });

    it("includes ISO-8601 timestamp", async () => {
      const result = await emitter.emit("signup_start", "user-abc");

      expect(result).not.toBeNull();
      // Verify it's a valid ISO-8601 date
      const parsed = new Date(result!.timestamp);
      expect(parsed.toISOString()).toBe(result!.timestamp);
    });

    it("includes optional metadata", async () => {
      const result = await emitter.emit(
        "landing_cta_click",
        "user-abc",
        { variant: "hero", source: "homepage" },
      );

      expect(result!.metadata).toEqual({ variant: "hero", source: "homepage" });
    });

    it("includes optional sessionId", async () => {
      const result = await emitter.emit(
        "landing_cta_click",
        "user-abc",
        undefined,
        "session-xyz",
      );

      expect(result!.sessionId).toBe("session-xyz");
    });

    it("emits all five funnel stages", async () => {
      for (const stage of FUNNEL_STAGES) {
        await emitter.emit(stage, "user-1");
      }

      expect(sink.events).toHaveLength(5);
      expect(sink.events.map((e) => e.stage)).toEqual([...FUNNEL_STAGES]);
    });

    it("is a no-op when disabled", async () => {
      const disabledEmitter = new FunnelEmitter(sink, {
        enabled: false,
        verbose: false,
      });

      const result = await disabledEmitter.emit("landing_cta_click", "user-abc");

      expect(result).toBeNull();
      expect(sink.events).toHaveLength(0);
    });

    it("isEnabled() reflects config", () => {
      expect(emitter.isEnabled()).toBe(true);

      const disabled = new FunnelEmitter(sink, { enabled: false, verbose: false });
      expect(disabled.isEnabled()).toBe(false);
    });

    it("logs to console when verbose is true", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const verboseEmitter = new FunnelEmitter(sink, {
        enabled: true,
        verbose: true,
      });

      await verboseEmitter.emit("signup_start", "user-verbose");

      expect(consoleSpy).toHaveBeenCalledWith(
        "[funnel] signup_start user=user-verbose",
      );
      consoleSpy.mockRestore();
    });

    it("does not log to console when verbose is false", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await emitter.emit("signup_start", "user-quiet");

      // Only the sink write should have happened, no console.log from emitter
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // parseFunnelConfig
  // -----------------------------------------------------------------------
  describe("parseFunnelConfig", () => {
    it("returns defaults when no env vars set", () => {
      const config = parseFunnelConfig({});
      expect(config.enabled).toBe(true);
      expect(config.verbose).toBe(false);
    });

    it("disables when FUNNEL_ENABLED=false", () => {
      const config = parseFunnelConfig({ FUNNEL_ENABLED: "false" });
      expect(config.enabled).toBe(false);
    });

    it("enables when FUNNEL_ENABLED=true", () => {
      const config = parseFunnelConfig({ FUNNEL_ENABLED: "true" });
      expect(config.enabled).toBe(true);
    });

    it("enables verbose when FUNNEL_VERBOSE=true", () => {
      const config = parseFunnelConfig({ FUNNEL_VERBOSE: "true" });
      expect(config.verbose).toBe(true);
    });

    it("keeps verbose off for any non-true value", () => {
      expect(parseFunnelConfig({ FUNNEL_VERBOSE: "false" }).verbose).toBe(false);
      expect(parseFunnelConfig({ FUNNEL_VERBOSE: "yes" }).verbose).toBe(false);
      expect(parseFunnelConfig({ FUNNEL_VERBOSE: "1" }).verbose).toBe(false);
    });

    it("treats undefined FUNNEL_ENABLED as enabled", () => {
      const config = parseFunnelConfig({ FUNNEL_ENABLED: undefined });
      expect(config.enabled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // createFunnelEmitter factory
  // -----------------------------------------------------------------------
  describe("createFunnelEmitter", () => {
    it("creates enabled emitter by default", () => {
      const emitter = createFunnelEmitter({});
      expect(emitter.isEnabled()).toBe(true);
    });

    it("creates disabled emitter when FUNNEL_ENABLED=false", () => {
      const emitter = createFunnelEmitter({ FUNNEL_ENABLED: "false" });
      expect(emitter.isEnabled()).toBe(false);
    });

    it("uses provided sink when given", async () => {
      const sink = new MemoryEventSink();
      const emitter = createFunnelEmitter({}, sink);

      await emitter.emit("landing_cta_click", "u1");
      expect(sink.events).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Validation helpers
  // -----------------------------------------------------------------------
  describe("isValidFunnelStage", () => {
    it("returns true for all defined stages", () => {
      for (const stage of FUNNEL_STAGES) {
        expect(isValidFunnelStage(stage)).toBe(true);
      }
    });

    it("returns false for unknown stages", () => {
      expect(isValidFunnelStage("unknown_stage")).toBe(false);
      expect(isValidFunnelStage("")).toBe(false);
      expect(isValidFunnelStage("LANDING_CTA_CLICK")).toBe(false);
    });
  });

  describe("getFunnelStageIndex", () => {
    it("returns correct zero-based index for each stage", () => {
      expect(getFunnelStageIndex("landing_cta_click")).toBe(0);
      expect(getFunnelStageIndex("signup_start")).toBe(1);
      expect(getFunnelStageIndex("first_provider_connect")).toBe(2);
      expect(getFunnelStageIndex("first_sync_complete")).toBe(3);
      expect(getFunnelStageIndex("first_insight_viewed")).toBe(4);
    });

    it("returns -1 for unknown stages", () => {
      expect(getFunnelStageIndex("not_a_stage")).toBe(-1);
    });
  });

  describe("getNextFunnelStage", () => {
    it("returns the next stage for each non-terminal stage", () => {
      expect(getNextFunnelStage("landing_cta_click")).toBe("signup_start");
      expect(getNextFunnelStage("signup_start")).toBe("first_provider_connect");
      expect(getNextFunnelStage("first_provider_connect")).toBe("first_sync_complete");
      expect(getNextFunnelStage("first_sync_complete")).toBe("first_insight_viewed");
    });

    it("returns null for the last stage", () => {
      expect(getNextFunnelStage("first_insight_viewed")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // DEFAULT_FUNNEL_CONFIG
  // -----------------------------------------------------------------------
  describe("DEFAULT_FUNNEL_CONFIG", () => {
    it("has sane defaults", () => {
      expect(DEFAULT_FUNNEL_CONFIG.enabled).toBe(true);
      expect(DEFAULT_FUNNEL_CONFIG.verbose).toBe(false);
    });
  });
});
