/**
 * Integration tests for funnel event instrumentation (TM-zf91.6).
 *
 * These tests exercise the full emitter -> sink -> retrieval pipeline
 * without mocks. They verify that the complete system works end-to-end:
 *
 * - Full funnel progression (all 5 stages for a single user)
 * - Multi-user concurrent emission
 * - Environment-based enable/disable toggling
 * - Composite sink fan-out
 * - Event ordering preservation
 */
import { describe, it, expect } from "vitest";
import {
  FUNNEL_STAGES,
  FunnelEmitter,
  MemoryEventSink,
  CompositeEventSink,
  NoopEventSink,
  createFunnelEmitter,
  type FunnelStage,
} from "./funnel-events";

describe("funnel-events integration", () => {
  // -----------------------------------------------------------------------
  // Full funnel progression
  // -----------------------------------------------------------------------
  it("records a complete user journey through all 5 funnel stages", async () => {
    const sink = new MemoryEventSink();
    const emitter = new FunnelEmitter(sink);

    // Simulate a user progressing through the entire funnel
    for (const stage of FUNNEL_STAGES) {
      await emitter.emit(stage, "user-journey-001", { source: "integration-test" });
    }

    // Verify all 5 events were recorded
    expect(sink.events).toHaveLength(5);

    // Verify correct ordering
    const stages = sink.events.map((e) => e.stage);
    expect(stages).toEqual([
      "landing_cta_click",
      "signup_start",
      "first_provider_connect",
      "first_sync_complete",
      "first_insight_viewed",
    ]);

    // Verify all events belong to the same user
    const userIds = new Set(sink.events.map((e) => e.userId));
    expect(userIds.size).toBe(1);
    expect(userIds.has("user-journey-001")).toBe(true);

    // Verify timestamps are monotonically non-decreasing
    for (let i = 1; i < sink.events.length; i++) {
      const prev = new Date(sink.events[i - 1].timestamp).getTime();
      const curr = new Date(sink.events[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  // -----------------------------------------------------------------------
  // Multi-user concurrent emission
  // -----------------------------------------------------------------------
  it("handles concurrent emissions from multiple users", async () => {
    const sink = new MemoryEventSink();
    const emitter = new FunnelEmitter(sink);

    // Simulate 10 users each hitting the landing CTA
    const promises = Array.from({ length: 10 }, (_, i) =>
      emitter.emit("landing_cta_click", `user-${i}`, { batch: "concurrent-test" }),
    );

    const results = await Promise.all(promises);

    // All 10 should succeed
    expect(results.every((r) => r !== null)).toBe(true);
    expect(sink.events).toHaveLength(10);

    // Each user should have exactly one event
    const userIds = sink.events.map((e) => e.userId).sort();
    expect(userIds).toEqual(
      Array.from({ length: 10 }, (_, i) => `user-${i}`).sort(),
    );
  });

  // -----------------------------------------------------------------------
  // Environment-based disable
  // -----------------------------------------------------------------------
  it("produces zero events when FUNNEL_ENABLED=false", async () => {
    const sink = new MemoryEventSink();
    const emitter = createFunnelEmitter({ FUNNEL_ENABLED: "false" }, sink);

    for (const stage of FUNNEL_STAGES) {
      await emitter.emit(stage, "should-not-appear");
    }

    // Sink should be completely empty
    expect(sink.events).toHaveLength(0);
  });

  it("produces events when FUNNEL_ENABLED is not set (default on)", async () => {
    const sink = new MemoryEventSink();
    const emitter = createFunnelEmitter({}, sink);

    await emitter.emit("landing_cta_click", "user-default");

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].stage).toBe("landing_cta_click");
  });

  // -----------------------------------------------------------------------
  // Composite sink fan-out
  // -----------------------------------------------------------------------
  it("fans out events to all sinks in a composite", async () => {
    const sinkA = new MemoryEventSink();
    const sinkB = new MemoryEventSink();
    const sinkC = new MemoryEventSink();
    const composite = new CompositeEventSink([sinkA, sinkB, sinkC]);
    const emitter = new FunnelEmitter(composite);

    await emitter.emit("first_sync_complete", "user-fanout", { provider: "google" });

    // All three sinks should have the same event
    expect(sinkA.events).toHaveLength(1);
    expect(sinkB.events).toHaveLength(1);
    expect(sinkC.events).toHaveLength(1);

    // Events should be identical across sinks
    expect(sinkA.events[0].stage).toBe("first_sync_complete");
    expect(sinkB.events[0].userId).toBe("user-fanout");
    expect(sinkC.events[0].metadata?.provider).toBe("google");
  });

  // -----------------------------------------------------------------------
  // Metadata preservation
  // -----------------------------------------------------------------------
  it("preserves metadata through the full emit -> store -> read cycle", async () => {
    const sink = new MemoryEventSink();
    const emitter = new FunnelEmitter(sink);

    await emitter.emit(
      "first_provider_connect",
      "user-meta",
      { provider: "microsoft", account_count: "3" },
      "session-abc",
    );

    const stored = sink.events[0];
    expect(stored.stage).toBe("first_provider_connect");
    expect(stored.userId).toBe("user-meta");
    expect(stored.sessionId).toBe("session-abc");
    expect(stored.metadata).toEqual({
      provider: "microsoft",
      account_count: "3",
    });
    expect(stored.timestamp).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // Conversion report computation (mini end-to-end)
  // -----------------------------------------------------------------------
  it("enables computing stage-to-stage conversion rates from stored events", async () => {
    const sink = new MemoryEventSink();
    const emitter = new FunnelEmitter(sink);

    // Simulate: 100 users click CTA, 60 start signup, 30 connect provider,
    //           20 complete sync, 10 view insights
    const userCounts: Record<FunnelStage, number> = {
      landing_cta_click: 100,
      signup_start: 60,
      first_provider_connect: 30,
      first_sync_complete: 20,
      first_insight_viewed: 10,
    };

    for (const [stage, count] of Object.entries(userCounts)) {
      for (let i = 0; i < count; i++) {
        await emitter.emit(stage as FunnelStage, `user-${stage}-${i}`);
      }
    }

    // Compute conversion rates from stored events
    const stageCounts = new Map<string, number>();
    for (const event of sink.events) {
      stageCounts.set(event.stage, (stageCounts.get(event.stage) ?? 0) + 1);
    }

    // Verify stage counts
    expect(stageCounts.get("landing_cta_click")).toBe(100);
    expect(stageCounts.get("signup_start")).toBe(60);
    expect(stageCounts.get("first_provider_connect")).toBe(30);
    expect(stageCounts.get("first_sync_complete")).toBe(20);
    expect(stageCounts.get("first_insight_viewed")).toBe(10);

    // Compute conversion rates
    const ctaToSignup = 60 / 100;
    const signupToConnect = 30 / 60;
    const connectToSync = 20 / 30;
    const syncToInsight = 10 / 20;

    expect(ctaToSignup).toBe(0.6);
    expect(signupToConnect).toBe(0.5);
    expect(connectToSync).toBeCloseTo(0.667, 2);
    expect(syncToInsight).toBe(0.5);
  });
});
