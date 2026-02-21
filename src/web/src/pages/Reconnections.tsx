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
 * Uses useApi() for token-injected API calls (migrated from prop-passing).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../lib/api-provider";
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
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Reconnections() {
  const api = useApi();

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
        api.fetchReconnectionSuggestions(),
        api.fetchUpcomingMilestones(),
      ]);
      if (!mountedRef.current) return;
      setSuggestions(suggestionsData);
      setMilestones(milestonesData);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api]);

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
      <div data-testid="reconnections-loading" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground m-0">Reconnections</h1>
        <p className="text-muted-foreground text-center py-8">Loading reconnection data...</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Error
  // -------------------------------------------------------------------------

  if (error) {
    return (
      <div data-testid="reconnections-error" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground m-0">Reconnections</h1>
        <div className="text-destructive text-center py-8">
          <p>Failed to load reconnection data: {error}</p>
          <Button
            onClick={async () => {
              setLoading(true);
              setError(null);
              await loadData();
              setLoading(false);
            }}
            variant="outline"
            className="mt-2 border-destructive text-destructive hover:bg-destructive/10"
            aria-label="Retry"
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Main
  // -------------------------------------------------------------------------

  return (
    <div data-testid="reconnections-page" className="mx-auto max-w-[1200px]">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-foreground m-0">Reconnections</h1>
        <div className="flex gap-3 items-center flex-wrap">
          <a href="#/relationships" className="text-muted-foreground text-sm no-underline hover:text-foreground">
            Back to Relationships
          </a>
        </div>
      </div>

      {/* Trip Reconnections Section */}
      <Card data-testid="trip-reconnections" className="mb-6">
        <CardContent className="p-6">
          <h2 className="text-lg font-bold text-foreground mt-0 mb-4">Trip Reconnection Opportunities</h2>
          {tripGroups.length === 0 ? (
            <div data-testid="suggestions-empty" className="text-muted-foreground text-center py-8">
              No reconnection suggestions at this time. Add trips and relationships to see opportunities.
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {tripGroups.map((group) => (
                <TripGroupSection key={group.city} group={group} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Milestone Calendar Section */}
      <Card data-testid="milestone-calendar" className="mb-6">
        <CardContent className="p-6">
          <h2 className="text-lg font-bold text-foreground mt-0 mb-4">Upcoming Milestones</h2>
          {upcomingMilestones.length === 0 ? (
            <div data-testid="milestones-empty" className="text-muted-foreground text-center py-8">
              No upcoming milestones in the next 30 days.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {Array.from(milestonesByMonth.entries()).map(([monthKey, monthMilestones]) => (
                <div key={monthKey} className="border-l-[3px] border-violet-500 pl-4">
                  <h3 className="text-base font-semibold text-foreground m-0 mb-2">{formatMonthLabel(monthKey)}</h3>
                  <div className="flex flex-col gap-1.5">
                    {monthMilestones.map((milestone) => (
                      <MilestoneRow key={milestone.milestone_id} milestone={milestone} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
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
    <div className="border-l-[3px] border-primary pl-4">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <h3 className="text-base font-bold text-foreground m-0">{group.city}</h3>
        {dateRange && (
          <span className="text-xs text-muted-foreground">{dateRange}</span>
        )}
        <span className="text-xs text-slate-500 px-1.5 py-0.5 bg-background rounded">
          {group.suggestions.length} contact{group.suggestions.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="flex flex-col gap-2">
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
      className="px-4 py-3 bg-background rounded-lg border border-border"
    >
      <div className="flex justify-between items-center mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-[150px]">
          <span className="text-sm text-foreground font-semibold">{card.name}</span>
          <span
            className="px-1.5 py-0.5 rounded text-[0.7rem] font-semibold whitespace-nowrap"
            style={{
              color: driftColor(severity),
              backgroundColor: driftBgColor(severity),
            }}
          >
            {formatDriftDays(card.daysOverdue)}
          </span>
        </div>
        <span className="text-xs text-slate-500 uppercase tracking-wider">{card.category}</span>
      </div>
      <div className="flex gap-3 items-center mb-2 flex-wrap">
        <span className="text-xs text-muted-foreground">{card.suggestedAction}</span>
        <span className="text-xs text-primary font-semibold">{formatSuggestedDuration(card.suggestedDurationMinutes)}</span>
        {card.timeWindow && (
          <span className="text-xs text-slate-500">
            {formatMilestoneDate(card.timeWindow.earliest)} - {formatMilestoneDate(card.timeWindow.latest)}
          </span>
        )}
      </div>
      <div className="flex justify-end">
        <a
          data-testid={`schedule-btn-${card.relationshipId}`}
          href={scheduleUrl}
          className="px-3 py-1.5 rounded-md border border-primary text-primary text-xs font-semibold no-underline hover:bg-primary/10 inline-block"
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
      className="flex justify-between items-center px-3 py-2 bg-background rounded-md border border-border flex-wrap gap-2"
    >
      <div className="flex items-center gap-2 flex-1 min-w-[150px]">
        <span className="text-xs text-muted-foreground font-semibold min-w-[50px]">
          {formatMilestoneDate(milestone.next_occurrence)}
        </span>
        <span
          className="text-[0.7rem] font-semibold whitespace-nowrap px-1.5 py-0.5 rounded"
          style={{ color: "#8b5cf6", backgroundColor: "#2e1065" }}
        >
          {milestoneKindLabel(milestone.kind)}
        </span>
        <span className="text-sm text-foreground">{displayName}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-amber-500 font-semibold whitespace-nowrap">
          {milestone.days_until} days
        </span>
        {milestone.note && (
          <span className="text-xs text-slate-500 italic">{milestone.note}</span>
        )}
      </div>
    </div>
  );
}
