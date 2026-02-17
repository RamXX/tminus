/**
 * Funnel event instrumentation for GTM validation loop.
 *
 * Defines the five key funnel stages that track user progression
 * from landing page through to first value realization:
 *
 *   1. landing_cta_click    -- User clicks a CTA on the public site
 *   2. signup_start         -- User initiates account creation
 *   3. first_provider_connect -- User connects their first calendar provider
 *   4. first_sync_complete  -- First sync finishes successfully
 *   5. first_insight_viewed -- User views their first intelligence insight
 *
 * Events are emitted to an EventSink abstraction, allowing different
 * backends (D1, console, analytics API) and per-environment disabling.
 *
 * Privacy: Events contain only anonymous session/user IDs and timestamps.
 * No PII is included in the event payload.
 *
 * @module funnel-events
 * @see docs/business/roadmap.md for weekly review cadence
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The ordered set of funnel stages. */
export const FUNNEL_STAGES = [
  "landing_cta_click",
  "signup_start",
  "first_provider_connect",
  "first_sync_complete",
  "first_insight_viewed",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/**
 * A single funnel event. Minimal by design -- no PII, no rich context.
 * Enrichment happens at the reporting layer, not the emission layer.
 */
export interface FunnelEvent {
  /** Funnel stage that occurred. */
  stage: FunnelStage;
  /** Anonymous user identifier (e.g. hashed user ID). */
  userId: string;
  /** Optional anonymous session identifier for multi-touch attribution. */
  sessionId?: string;
  /** ISO-8601 timestamp. Defaults to now if omitted at emission time. */
  timestamp: string;
  /** Arbitrary metadata (e.g. CTA variant, provider type). */
  metadata?: Record<string, string>;
}

/**
 * Configuration for funnel event instrumentation.
 * Controls whether events are emitted and where they go.
 */
export interface FunnelConfig {
  /** Master switch. When false, emit() is a no-op. Defaults to true. */
  enabled: boolean;
  /** If true, log events to console in addition to the sink. Defaults to false. */
  verbose: boolean;
}

/** Default configuration -- instrumentation ON, verbose OFF. */
export const DEFAULT_FUNNEL_CONFIG: FunnelConfig = {
  enabled: true,
  verbose: false,
};

/**
 * Parse funnel configuration from environment variables.
 *
 * Recognized variables:
 *   FUNNEL_ENABLED  -- "true" | "false" (default: "true")
 *   FUNNEL_VERBOSE  -- "true" | "false" (default: "false")
 */
export function parseFunnelConfig(env: Record<string, string | undefined>): FunnelConfig {
  return {
    enabled: env.FUNNEL_ENABLED !== "false",
    verbose: env.FUNNEL_VERBOSE === "true",
  };
}

// ---------------------------------------------------------------------------
// EventSink abstraction
// ---------------------------------------------------------------------------

/**
 * Abstraction for persisting funnel events.
 * Implementations can write to D1, KV, analytics APIs, or stdout.
 */
export interface EventSink {
  write(event: FunnelEvent): Promise<void>;
}

/** Console sink -- writes events as JSON to console.log. Useful for dev/staging. */
export class ConsoleEventSink implements EventSink {
  async write(event: FunnelEvent): Promise<void> {
    console.log(JSON.stringify({ _type: "funnel_event", ...event }));
  }
}

/**
 * In-memory sink -- accumulates events in an array.
 * Useful for testing and dry-run report generation.
 */
export class MemoryEventSink implements EventSink {
  public events: FunnelEvent[] = [];

  async write(event: FunnelEvent): Promise<void> {
    this.events.push(event);
  }

  clear(): void {
    this.events = [];
  }
}

/**
 * Composite sink -- writes to multiple sinks in parallel.
 * Useful for writing to both D1 and console simultaneously.
 */
export class CompositeEventSink implements EventSink {
  constructor(private readonly sinks: EventSink[]) {}

  async write(event: FunnelEvent): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.write(event)));
  }
}

/**
 * No-op sink -- silently discards events.
 * Used when instrumentation is disabled.
 */
export class NoopEventSink implements EventSink {
  async write(_event: FunnelEvent): Promise<void> {
    // Intentionally empty -- instrumentation disabled.
  }
}

// ---------------------------------------------------------------------------
// FunnelEmitter
// ---------------------------------------------------------------------------

/**
 * Main entry point for emitting funnel events.
 *
 * Usage:
 * ```ts
 * const emitter = new FunnelEmitter(sink, config);
 * await emitter.emit("landing_cta_click", "user-abc", { variant: "hero" });
 * ```
 */
export class FunnelEmitter {
  private readonly sink: EventSink;
  private readonly config: FunnelConfig;

  constructor(sink: EventSink, config: FunnelConfig = DEFAULT_FUNNEL_CONFIG) {
    this.sink = config.enabled ? sink : new NoopEventSink();
    this.config = config;
  }

  /**
   * Emit a funnel event. No-op if instrumentation is disabled.
   */
  async emit(
    stage: FunnelStage,
    userId: string,
    metadata?: Record<string, string>,
    sessionId?: string,
  ): Promise<FunnelEvent | null> {
    if (!this.config.enabled) {
      return null;
    }

    const event: FunnelEvent = {
      stage,
      userId,
      sessionId,
      timestamp: new Date().toISOString(),
      metadata,
    };

    if (this.config.verbose) {
      console.log(`[funnel] ${stage} user=${userId}`);
    }

    await this.sink.write(event);
    return event;
  }

  /** Check if instrumentation is enabled. */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a FunnelEmitter from environment variables and sink.
 * Convenience factory for worker entry points.
 */
export function createFunnelEmitter(
  env: Record<string, string | undefined>,
  sink?: EventSink,
): FunnelEmitter {
  const config = parseFunnelConfig(env);
  const resolvedSink = sink ?? (config.verbose ? new ConsoleEventSink() : new NoopEventSink());
  return new FunnelEmitter(resolvedSink, config);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Check if a string is a valid funnel stage. */
export function isValidFunnelStage(stage: string): stage is FunnelStage {
  return (FUNNEL_STAGES as readonly string[]).includes(stage);
}

/**
 * Get the zero-indexed position of a funnel stage.
 * Returns -1 for invalid stages.
 */
export function getFunnelStageIndex(stage: string): number {
  return (FUNNEL_STAGES as readonly string[]).indexOf(stage);
}

/**
 * Get the next stage in the funnel, or null if at the last stage.
 */
export function getNextFunnelStage(stage: FunnelStage): FunnelStage | null {
  const idx = FUNNEL_STAGES.indexOf(stage);
  if (idx < 0 || idx >= FUNNEL_STAGES.length - 1) return null;
  return FUNNEL_STAGES[idx + 1];
}
