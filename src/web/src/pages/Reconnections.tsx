/**
 * Reconnections Dashboard page.
 *
 * Provides a UI for viewing trip-based reconnection suggestions and
 * upcoming milestones. Reconnection cards show overdue contacts grouped
 * by city (trip destination) with actionable schedule buttons.
 *
 * Views:
 * - Trip reconnection list: contacts grouped by city with drift indicators
 * - Milestone calendar: upcoming life events grouped by month
 * - Reconnection cards: contact name, city, drift days, suggested action
 * - Schedule button: pre-fills scheduling form with contact and trip constraints
 *
 * The component accepts fetch functions as props for testability.
 * In production, these are wired to the API client with auth tokens in App.tsx.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  ReconnectionSuggestionFull,
  UpcomingMilestone,
  TripReconnectionGroup,
  ReconnectionCardData,
} from "../lib/reconnections";
import {
  groupByCity,
  filterUpcomingMilestones,
  groupMilestonesByMonth,
  formatMonthLabel,
  formatDriftDays,
  formatSuggestedDuration,
  formatMilestoneDate,
  milestoneKindLabel,
  driftSeverityFromRatio,
  toReconnectionCard,
  buildScheduleUrl,
} from "../lib/reconnections";
import {
  driftColor,
  driftBgColor,
} from "../lib/relationships";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ReconnectionsProps {
  /** Fetch reconnection suggestions (full typed). */
  fetchReconnectionSuggestions: () => Promise<ReconnectionSuggestionFull[]>;
  /** Fetch upcoming milestones. */
  fetchUpcomingMilestones: () => Promise<UpcomingMilestone[]>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Reconnections({
  fetchReconnectionSuggestions,
  fetchUpcomingMilestones,
}: ReconnectionsProps) {
  // -- State: data --
  const [suggestions, setSuggestions] = useState<ReconnectionSuggestionFull[]>([]);
  const [milestones, setMilestones] = useState<UpcomingMilestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  // -------------------------------------------------------------------------
  // Load data
  // -------------------------------------------------------------------------

  const loadData = useCallback(async () => {
    try {
      const [suggestionsData, milestonesData] = await Promise.all([
        fetchReconnectionSuggestions(),
        fetchUpcomingMilestones(),
      ]);
      if (!mountedRef.current) return;
      setSuggestions(suggestionsData);
      setMilestones(milestonesData);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [fetchReconnectionSuggestions, fetchUpcomingMilestones]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function load() {
      await loadData();
      if (!cancelled && mountedRef.current) {
        setLoading(false);
      }
    }
    load();

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [loadData]);

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  const tripGroups = groupByCity(suggestions);
  const upcomingMilestones = filterUpcomingMilestones(milestones, 30);
  const milestonesByMonth = groupMilestonesByMonth(upcomingMilestones);

  // -------------------------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div data-testid="reconnections-loading" style={styles.container}>
        <h1 style={styles.title}>Reconnections</h1>
        <div style={styles.loading}>Loading reconnection data...</div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Error
  // -------------------------------------------------------------------------

  if (error) {
    return (
      <div data-testid="reconnections-error" style={styles.container}>
        <h1 style={styles.title}>Reconnections</h1>
        <div style={styles.errorBox}>
          <p>Failed to load reconnection data: {error}</p>
          <button
            onClick={async () => {
              setLoading(true);
              setError(null);
              await loadData();
              setLoading(false);
            }}
            style={styles.retryBtn}
            aria-label="Retry"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Main
  // -------------------------------------------------------------------------

  return (
    <div data-testid="reconnections-page" style={styles.container}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Reconnections</h1>
        <div style={styles.headerActions}>
          <a href="#/relationships" style={styles.backLink}>
            Back to Relationships
          </a>
        </div>
      </div>

      {/* Trip Reconnections Section */}
      <div data-testid="trip-reconnections" style={styles.card}>
        <h2 style={styles.sectionTitle}>Trip Reconnection Opportunities</h2>
        {tripGroups.length === 0 ? (
          <div data-testid="suggestions-empty" style={styles.emptyState}>
            No reconnection suggestions at this time. Add trips and relationships to see opportunities.
          </div>
        ) : (
          <div style={styles.groupsContainer}>
            {tripGroups.map((group) => (
              <TripGroupSection key={group.city} group={group} />
            ))}
          </div>
        )}
      </div>

      {/* Milestone Calendar Section */}
      <div data-testid="milestone-calendar" style={styles.card}>
        <h2 style={styles.sectionTitle}>Upcoming Milestones</h2>
        {upcomingMilestones.length === 0 ? (
          <div data-testid="milestones-empty" style={styles.emptyState}>
            No upcoming milestones in the next 30 days.
          </div>
        ) : (
          <div style={styles.milestoneContainer}>
            {Array.from(milestonesByMonth.entries()).map(([monthKey, monthMilestones]) => (
              <div key={monthKey} style={styles.monthGroup}>
                <h3 style={styles.monthLabel}>{formatMonthLabel(monthKey)}</h3>
                <div style={styles.milestoneList}>
                  {monthMilestones.map((milestone) => (
                    <MilestoneRow key={milestone.milestone_id} milestone={milestone} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TripGroupSection({ group }: { group: TripReconnectionGroup }) {
  const dateRange = group.tripStart && group.tripEnd
    ? `${formatMilestoneDate(group.tripStart)} - ${formatMilestoneDate(group.tripEnd)}`
    : "";

  return (
    <div style={styles.tripGroup}>
      <div style={styles.tripGroupHeader}>
        <h3 style={styles.tripCityName}>{group.city}</h3>
        {dateRange && (
          <span style={styles.tripDateRange}>{dateRange}</span>
        )}
        <span style={styles.tripCount}>
          {group.suggestions.length} contact{group.suggestions.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div style={styles.cardsList}>
        {group.suggestions.map((suggestion) => {
          const card = toReconnectionCard(suggestion);
          return <ReconnectionCard key={suggestion.relationship_id} card={card} />;
        })}
      </div>
    </div>
  );
}

function ReconnectionCard({ card }: { card: ReconnectionCardData }) {
  const severity = driftSeverityFromRatio(card.driftRatio);
  const scheduleUrl = buildScheduleUrl(card);

  return (
    <div
      data-testid={`reconnection-card-${card.relationshipId}`}
      style={styles.reconnectionCard}
    >
      <div style={styles.cardTop}>
        <div style={styles.cardInfo}>
          <span style={styles.cardName}>{card.name}</span>
          <span
            style={{
              ...styles.driftBadge,
              color: driftColor(severity),
              backgroundColor: driftBgColor(severity),
            }}
          >
            {formatDriftDays(card.daysOverdue)}
          </span>
        </div>
        <span style={styles.cardCategory}>{card.category}</span>
      </div>
      <div style={styles.cardMeta}>
        <span style={styles.cardAction}>{card.suggestedAction}</span>
        <span style={styles.cardDuration}>{formatSuggestedDuration(card.suggestedDurationMinutes)}</span>
        {card.timeWindow && (
          <span style={styles.cardWindow}>
            {formatMilestoneDate(card.timeWindow.earliest)} - {formatMilestoneDate(card.timeWindow.latest)}
          </span>
        )}
      </div>
      <div style={styles.cardActions}>
        <a
          data-testid={`schedule-btn-${card.relationshipId}`}
          href={scheduleUrl}
          style={styles.scheduleBtn}
        >
          Schedule Meeting
        </a>
      </div>
    </div>
  );
}

function MilestoneRow({ milestone }: { milestone: UpcomingMilestone }) {
  const displayName = milestone.display_name ?? "Unknown";

  return (
    <div
      data-testid={`milestone-${milestone.milestone_id}`}
      style={styles.milestoneRow}
    >
      <div style={styles.milestoneInfo}>
        <span style={styles.milestoneDate}>
          {formatMilestoneDate(milestone.next_occurrence)}
        </span>
        <span style={styles.milestoneKind}>
          {milestoneKindLabel(milestone.kind)}
        </span>
        <span style={styles.milestoneName}>{displayName}</span>
      </div>
      <div style={styles.milestoneMeta}>
        <span style={styles.milestoneDaysUntil}>
          {milestone.days_until} days
        </span>
        {milestone.note && (
          <span style={styles.milestoneNote}>{milestone.note}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (consistent with Relationships.tsx / Governance.tsx patterns)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "1200px",
    margin: "0 auto",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1rem",
    flexWrap: "wrap" as const,
    gap: "0.5rem",
  },
  headerActions: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "center",
    flexWrap: "wrap" as const,
  },
  title: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#f1f5f9",
    margin: 0,
  },
  backLink: {
    color: "#94a3b8",
    fontSize: "0.875rem",
    textDecoration: "none",
  },
  loading: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
  errorBox: {
    color: "#fca5a5",
    padding: "2rem",
    textAlign: "center" as const,
  },
  retryBtn: {
    marginTop: "0.5rem",
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  emptyState: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },

  // -- Card --
  card: {
    backgroundColor: "#1e293b",
    borderRadius: "12px",
    padding: "1.5rem",
    border: "1px solid #334155",
    marginBottom: "2rem",
  },
  sectionTitle: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "#f1f5f9",
    marginTop: 0,
    marginBottom: "1rem",
  },

  // -- Trip Groups --
  groupsContainer: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "1.5rem",
  },
  tripGroup: {
    borderLeft: "3px solid #3b82f6",
    paddingLeft: "1rem",
  },
  tripGroupHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    marginBottom: "0.75rem",
    flexWrap: "wrap" as const,
  },
  tripCityName: {
    fontSize: "1rem",
    fontWeight: 700,
    color: "#e2e8f0",
    margin: 0,
  },
  tripDateRange: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  tripCount: {
    fontSize: "0.75rem",
    color: "#64748b",
    padding: "0.15rem 0.4rem",
    backgroundColor: "#0f172a",
    borderRadius: "3px",
  },

  // -- Reconnection Cards --
  cardsList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
  },
  reconnectionCard: {
    padding: "0.75rem 1rem",
    backgroundColor: "#0f172a",
    borderRadius: "8px",
    border: "1px solid #334155",
  },
  cardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "0.5rem",
    flexWrap: "wrap" as const,
    gap: "0.5rem",
  },
  cardInfo: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flex: 1,
    minWidth: "150px",
  },
  cardName: {
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 600,
  },
  driftBadge: {
    padding: "0.15rem 0.4rem",
    borderRadius: "3px",
    fontSize: "0.7rem",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  cardCategory: {
    fontSize: "0.75rem",
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  cardMeta: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "center",
    marginBottom: "0.5rem",
    flexWrap: "wrap" as const,
  },
  cardAction: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  cardDuration: {
    fontSize: "0.8rem",
    color: "#3b82f6",
    fontWeight: 600,
  },
  cardWindow: {
    fontSize: "0.75rem",
    color: "#64748b",
  },
  cardActions: {
    display: "flex",
    justifyContent: "flex-end",
  },
  scheduleBtn: {
    padding: "0.35rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #3b82f6",
    backgroundColor: "transparent",
    color: "#3b82f6",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontWeight: 600,
    textDecoration: "none",
    display: "inline-block",
  },

  // -- Milestone Calendar --
  milestoneContainer: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "1rem",
  },
  monthGroup: {
    borderLeft: "3px solid #8b5cf6",
    paddingLeft: "1rem",
  },
  monthLabel: {
    fontSize: "0.95rem",
    fontWeight: 600,
    color: "#e2e8f0",
    margin: "0 0 0.5rem 0",
  },
  milestoneList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.4rem",
  },
  milestoneRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.5rem 0.75rem",
    backgroundColor: "#0f172a",
    borderRadius: "6px",
    border: "1px solid #334155",
    flexWrap: "wrap" as const,
    gap: "0.5rem",
  },
  milestoneInfo: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flex: 1,
    minWidth: "150px",
  },
  milestoneDate: {
    fontSize: "0.8rem",
    color: "#94a3b8",
    fontWeight: 600,
    minWidth: "50px",
  },
  milestoneKind: {
    fontSize: "0.7rem",
    color: "#8b5cf6",
    padding: "0.1rem 0.35rem",
    backgroundColor: "#2e1065",
    borderRadius: "3px",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  milestoneName: {
    fontSize: "0.85rem",
    color: "#e2e8f0",
  },
  milestoneMeta: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap" as const,
  },
  milestoneDaysUntil: {
    fontSize: "0.75rem",
    color: "#f59e0b",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  milestoneNote: {
    fontSize: "0.75rem",
    color: "#64748b",
    fontStyle: "italic",
  },
};
