/**
 * Relationships Dashboard page.
 *
 * Provides a UI for relationship management: contact list with categories,
 * drift indicators, reputation badges. Relationship detail view with
 * interaction history, milestones, reputation scores.
 *
 * Views:
 * - Contact list: name, category badge, drift indicator, last interaction
 * - Contact detail: full profile, interaction timeline, reputation scores
 * - Drift report: overdue contacts ranked by importance
 * - Add relationship form: name, email, category, city, timezone, frequency
 *
 * Drift color coding:
 *   green = on track (#22c55e)
 *   yellow = drifting (#eab308)
 *   red = overdue (#ef4444)
 *
 * Uses useApi() for token-injected API calls (migrated from prop-passing).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../lib/api-provider";
import type {
  Relationship,
  ReputationScores,
  Outcome,
  DriftReport,
  RelationshipCategory,
} from "../lib/relationships";
import {
  driftColor,
  driftBgColor,
  driftLabel,
  categoryStyle,
  categoryLabel,
  formatDate,
  formatScore,
  sortByDriftSeverity,
  CATEGORIES,
  FREQUENCY_OPTIONS,
} from "../lib/relationships";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";

// ---------------------------------------------------------------------------
// View type
// ---------------------------------------------------------------------------

type ViewMode = "list" | "detail" | "drift" | "add";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Relationships() {
  const api = useApi();

  // -- State: data --
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- State: view --
  const [view, setView] = useState<ViewMode>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // -- State: detail --
  const [detailRelationship, setDetailRelationship] = useState<Relationship | null>(null);
  const [reputation, setReputation] = useState<ReputationScores | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // -- State: drift report --
  const [driftReport, setDriftReport] = useState<DriftReport | null>(null);
  const [driftLoading, setDriftLoading] = useState(false);

  // -- State: add form --
  const [formName, setFormName] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formCategory, setFormCategory] = useState<RelationshipCategory>("professional");
  const [formCity, setFormCity] = useState("");
  const [formTimezone, setFormTimezone] = useState("");
  const [formFrequency, setFormFrequency] = useState(30);
  const [submitting, setSubmitting] = useState(false);

  // -- State: edit mode --
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editCategory, setEditCategory] = useState<RelationshipCategory>("professional");
  const [editCity, setEditCity] = useState("");
  const [editTimezone, setEditTimezone] = useState("");
  const [editFrequency, setEditFrequency] = useState(30);

  // -- State: status feedback --
  const [statusMsg, setStatusMsg] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const mountedRef = useRef(true);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showStatus = useCallback(
    (type: "success" | "error", text: string) => {
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
      setStatusMsg({ type, text });
      statusTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setStatusMsg(null);
        }
        statusTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Load data
  // -------------------------------------------------------------------------

  const loadRelationships = useCallback(async () => {
    try {
      const result = await api.fetchRelationships();
      if (!mountedRef.current) return;
      setRelationships(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api]);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function load() {
      await loadRelationships();
      if (!cancelled && mountedRef.current) {
        setLoading(false);
      }
    }
    load();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, [loadRelationships]);

  // -------------------------------------------------------------------------
  // Detail view handlers
  // -------------------------------------------------------------------------

  const openDetail = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setView("detail");
      setDetailLoading(true);
      setEditing(false);
      try {
        const [rel, rep, outs] = await Promise.all([
          api.fetchRelationship(id),
          api.fetchReputation(id),
          api.fetchOutcomes(id),
        ]);
        if (!mountedRef.current) return;
        setDetailRelationship(rel);
        setReputation(rep);
        setOutcomes(outs);
      } catch (err) {
        if (!mountedRef.current) return;
        showStatus(
          "error",
          `Failed to load details: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
        setView("list");
      } finally {
        if (mountedRef.current) setDetailLoading(false);
      }
    },
    [api, showStatus],
  );

  // -------------------------------------------------------------------------
  // CRUD handlers
  // -------------------------------------------------------------------------

  const handleCreate = useCallback(async () => {
    if (!formName.trim() || !formEmail.trim()) return;

    setSubmitting(true);
    try {
      await api.createRelationship({
        name: formName.trim(),
        email: formEmail.trim(),
        category: formCategory,
        city: formCity.trim(),
        timezone: formTimezone.trim(),
        frequency_days: formFrequency,
      });
      if (!mountedRef.current) return;
      showStatus("success", "Relationship created.");
      setFormName("");
      setFormEmail("");
      setFormCategory("professional");
      setFormCity("");
      setFormTimezone("");
      setFormFrequency(30);
      setView("list");
      await loadRelationships();
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to create: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    formName, formEmail, formCategory, formCity, formTimezone, formFrequency,
    api, loadRelationships, showStatus,
  ]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await api.deleteRelationship(id);
        if (!mountedRef.current) return;
        showStatus("success", "Relationship deleted.");
        setView("list");
        await loadRelationships();
      } catch (err) {
        if (!mountedRef.current) return;
        showStatus(
          "error",
          `Failed to delete: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
    [api, loadRelationships, showStatus],
  );

  const startEditing = useCallback(() => {
    if (!detailRelationship) return;
    setEditName(detailRelationship.name);
    setEditEmail(detailRelationship.email);
    setEditCategory(detailRelationship.category);
    setEditCity(detailRelationship.city);
    setEditTimezone(detailRelationship.timezone);
    setEditFrequency(detailRelationship.frequency_days);
    setEditing(true);
  }, [detailRelationship]);

  const handleUpdate = useCallback(async () => {
    if (!selectedId || !editName.trim() || !editEmail.trim()) return;

    setSubmitting(true);
    try {
      const updated = await api.updateRelationship(selectedId, {
        name: editName.trim(),
        email: editEmail.trim(),
        category: editCategory,
        city: editCity.trim(),
        timezone: editTimezone.trim(),
        frequency_days: editFrequency,
      });
      if (!mountedRef.current) return;
      showStatus("success", "Relationship updated.");
      setDetailRelationship(updated);
      setEditing(false);
      await loadRelationships();
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to update: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    selectedId, editName, editEmail, editCategory, editCity, editTimezone, editFrequency,
    api, loadRelationships, showStatus,
  ]);

  // -------------------------------------------------------------------------
  // Drift report handler
  // -------------------------------------------------------------------------

  const openDriftReport = useCallback(async () => {
    setView("drift");
    setDriftLoading(true);
    try {
      const report = await api.fetchDriftReport();
      if (!mountedRef.current) return;
      setDriftReport(report);
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to load drift report: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
      setView("list");
    } finally {
      if (mountedRef.current) setDriftLoading(false);
    }
  }, [api, showStatus]);

  // -------------------------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div data-testid="relationships-loading" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground m-0">Relationships</h1>
        <p className="text-muted-foreground text-center py-8">Loading relationships...</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Error
  // -------------------------------------------------------------------------

  if (error) {
    return (
      <div data-testid="relationships-error" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground m-0">Relationships</h1>
        <div className="text-destructive text-center py-8">
          <p>Failed to load relationships: {error}</p>
          <Button
            onClick={async () => {
              setLoading(true);
              setError(null);
              await loadRelationships();
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
  // Render: Add Form View
  // -------------------------------------------------------------------------

  if (view === "add") {
    return (
      <div className="mx-auto max-w-[1200px]">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h1 className="text-2xl font-bold text-foreground m-0">Add Relationship</h1>
          <Button
            data-testid="back-to-list-btn"
            onClick={() => setView("list")}
            variant="outline"
            className="border-border text-muted-foreground"
          >
            Back to List
          </Button>
        </div>

        {statusMsg && (
          <div
            data-testid="relationships-status-msg"
            className={`px-4 py-2 rounded-md text-sm font-medium mb-4 border ${
              statusMsg.type === "success"
                ? "bg-emerald-950 text-emerald-300 border-emerald-600"
                : "bg-red-950 text-red-300 border-red-700"
            }`}
          >
            {statusMsg.text}
          </div>
        )}

        <Card data-testid="add-form">
          <CardContent className="p-6">
            <h2 className="text-lg font-bold text-foreground mt-0 mb-4">New Relationship</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-4">
              <div className="flex flex-col gap-1">
                <label htmlFor="rel-name" className="block text-xs text-muted-foreground uppercase tracking-wider">Name</label>
                <input
                  id="rel-name"
                  data-testid="form-name-input"
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Contact name"
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="rel-email" className="block text-xs text-muted-foreground uppercase tracking-wider">Email</label>
                <input
                  id="rel-email"
                  data-testid="form-email-input"
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="contact@example.com"
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="rel-category" className="block text-xs text-muted-foreground uppercase tracking-wider">Category</label>
                <select
                  id="rel-category"
                  data-testid="form-category-select"
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value as RelationshipCategory)}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {categoryLabel(cat)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="rel-city" className="block text-xs text-muted-foreground uppercase tracking-wider">City</label>
                <input
                  id="rel-city"
                  data-testid="form-city-input"
                  type="text"
                  value={formCity}
                  onChange={(e) => setFormCity(e.target.value)}
                  placeholder="San Francisco"
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="rel-timezone" className="block text-xs text-muted-foreground uppercase tracking-wider">Timezone</label>
                <input
                  id="rel-timezone"
                  data-testid="form-timezone-input"
                  type="text"
                  value={formTimezone}
                  onChange={(e) => setFormTimezone(e.target.value)}
                  placeholder="America/Los_Angeles"
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="rel-frequency" className="block text-xs text-muted-foreground uppercase tracking-wider">Contact Frequency</label>
                <select
                  id="rel-frequency"
                  data-testid="form-frequency-select"
                  value={formFrequency}
                  onChange={(e) => setFormFrequency(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                >
                  {FREQUENCY_OPTIONS.map((opt) => (
                    <option key={opt.days} value={opt.days}>
                      {opt.label} ({opt.days} days)
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Button
              data-testid="submit-create-btn"
              onClick={handleCreate}
              disabled={submitting || !formName.trim() || !formEmail.trim()}
            >
              {submitting ? "Creating..." : "Create Relationship"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Detail View
  // -------------------------------------------------------------------------

  if (view === "detail") {
    if (detailLoading) {
      return (
        <div data-testid="detail-loading" className="mx-auto max-w-[1200px]">
          <h1 className="text-2xl font-bold text-foreground m-0">Relationships</h1>
          <p className="text-muted-foreground text-center py-8">Loading contact details...</p>
        </div>
      );
    }

    if (!detailRelationship) {
      return (
        <div className="mx-auto max-w-[1200px]">
          <h1 className="text-2xl font-bold text-foreground m-0">Relationships</h1>
          <p className="text-muted-foreground text-center py-8">Contact not found.</p>
        </div>
      );
    }

    const catStyle = categoryStyle(detailRelationship.category);

    return (
      <div className="mx-auto max-w-[1200px]">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h1 className="text-2xl font-bold text-foreground m-0">Relationships</h1>
          <Button
            data-testid="back-to-list-btn"
            onClick={() => setView("list")}
            variant="outline"
            className="border-border text-muted-foreground"
          >
            Back to List
          </Button>
        </div>

        {statusMsg && (
          <div
            data-testid="relationships-status-msg"
            className={`px-4 py-2 rounded-md text-sm font-medium mb-4 border ${
              statusMsg.type === "success"
                ? "bg-emerald-950 text-emerald-300 border-emerald-600"
                : "bg-red-950 text-red-300 border-red-700"
            }`}
          >
            {statusMsg.text}
          </div>
        )}

        {/* Contact Profile */}
        <Card data-testid="contact-detail" className="mb-6">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4 flex-wrap gap-2">
              <div>
                <h2 data-testid="detail-name" className="text-xl font-bold text-foreground m-0">
                  {detailRelationship.name}
                </h2>
                <span data-testid="detail-email" className="text-sm text-muted-foreground">
                  {detailRelationship.email}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  data-testid="edit-btn"
                  onClick={startEditing}
                  variant="outline"
                  size="sm"
                  className="border-primary text-primary"
                >
                  Edit
                </Button>
                <Button
                  data-testid="delete-btn"
                  onClick={() => handleDelete(detailRelationship.id)}
                  variant="outline"
                  size="sm"
                  className="border-destructive text-destructive hover:bg-destructive/10"
                >
                  Delete
                </Button>
              </div>
            </div>

            <div className="flex gap-3 flex-wrap items-center">
              <span
                data-testid="detail-category"
                className="px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap"
                style={{
                  color: catStyle.color,
                  backgroundColor: catStyle.bg,
                }}
              >
                {categoryLabel(detailRelationship.category)}
              </span>
              <span
                data-testid="detail-drift"
                className="px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap"
                style={{
                  color: driftColor(detailRelationship.drift_level),
                  backgroundColor: driftBgColor(detailRelationship.drift_level),
                }}
              >
                {driftLabel(detailRelationship.drift_level)}
              </span>
              <span className="text-xs text-muted-foreground">
                {detailRelationship.city}
                {detailRelationship.timezone && ` (${detailRelationship.timezone})`}
              </span>
              <span className="text-xs text-muted-foreground">
                Frequency: every {detailRelationship.frequency_days} days
              </span>
              <span className="text-xs text-muted-foreground">
                Last interaction: {formatDate(detailRelationship.last_interaction)}
              </span>
            </div>

            {/* Edit Form (inline) */}
            {editing && (
              <div data-testid="edit-form" className="mt-6 border-t border-border pt-4">
                <h3 className="text-base font-semibold text-foreground mt-0 mb-3">Edit Relationship</h3>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-4">
                  <div className="flex flex-col gap-1">
                    <label htmlFor="edit-name" className="block text-xs text-muted-foreground uppercase tracking-wider">Name</label>
                    <input
                      id="edit-name"
                      data-testid="edit-name-input"
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor="edit-email" className="block text-xs text-muted-foreground uppercase tracking-wider">Email</label>
                    <input
                      id="edit-email"
                      data-testid="edit-email-input"
                      type="email"
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor="edit-category" className="block text-xs text-muted-foreground uppercase tracking-wider">Category</label>
                    <select
                      id="edit-category"
                      data-testid="edit-category-select"
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value as RelationshipCategory)}
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                    >
                      {CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {categoryLabel(cat)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor="edit-city" className="block text-xs text-muted-foreground uppercase tracking-wider">City</label>
                    <input
                      id="edit-city"
                      data-testid="edit-city-input"
                      type="text"
                      value={editCity}
                      onChange={(e) => setEditCity(e.target.value)}
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor="edit-timezone" className="block text-xs text-muted-foreground uppercase tracking-wider">Timezone</label>
                    <input
                      id="edit-timezone"
                      data-testid="edit-timezone-input"
                      type="text"
                      value={editTimezone}
                      onChange={(e) => setEditTimezone(e.target.value)}
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor="edit-frequency" className="block text-xs text-muted-foreground uppercase tracking-wider">Frequency</label>
                    <select
                      id="edit-frequency"
                      data-testid="edit-frequency-select"
                      value={editFrequency}
                      onChange={(e) => setEditFrequency(Number(e.target.value))}
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                    >
                      {FREQUENCY_OPTIONS.map((opt) => (
                        <option key={opt.days} value={opt.days}>
                          {opt.label} ({opt.days} days)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <Button
                    data-testid="save-edit-btn"
                    onClick={handleUpdate}
                    disabled={submitting || !editName.trim() || !editEmail.trim()}
                  >
                    {submitting ? "Saving..." : "Save Changes"}
                  </Button>
                  <Button
                    data-testid="cancel-edit-btn"
                    onClick={() => setEditing(false)}
                    variant="outline"
                    className="border-border text-muted-foreground"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Reputation Scores */}
        {reputation && (
          <Card data-testid="reputation-section" className="mb-6">
            <CardContent className="p-6">
              <h2 className="text-lg font-bold text-foreground mt-0 mb-4">Reputation Scores</h2>
              <div data-testid="reputation-scores" className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
                <div className="flex flex-col items-center p-3 bg-background rounded-lg border border-border">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Overall</span>
                  <span data-testid="score-overall" className="text-lg font-bold text-foreground">
                    {formatScore(reputation.overall_score)}
                  </span>
                </div>
                <div className="flex flex-col items-center p-3 bg-background rounded-lg border border-border">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Reliability</span>
                  <span data-testid="score-reliability" className="text-lg font-bold text-foreground">
                    {formatScore(reputation.reliability_score)}
                  </span>
                </div>
                <div className="flex flex-col items-center p-3 bg-background rounded-lg border border-border">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Responsiveness</span>
                  <span data-testid="score-responsiveness" className="text-lg font-bold text-foreground">
                    {formatScore(reputation.responsiveness_score)}
                  </span>
                </div>
                <div className="flex flex-col items-center p-3 bg-background rounded-lg border border-border">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Follow-through</span>
                  <span data-testid="score-follow-through" className="text-lg font-bold text-foreground">
                    {formatScore(reputation.follow_through_score)}
                  </span>
                </div>
                <div className="flex flex-col items-center p-3 bg-background rounded-lg border border-border">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Interactions</span>
                  <span data-testid="score-interactions" className="text-lg font-bold text-foreground">
                    {reputation.total_interactions}
                  </span>
                </div>
                <div className="flex flex-col items-center p-3 bg-background rounded-lg border border-border">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Positive</span>
                  <span data-testid="score-positive" className="text-lg font-bold text-green-500">
                    {reputation.positive_outcomes}
                  </span>
                </div>
                <div className="flex flex-col items-center p-3 bg-background rounded-lg border border-border">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Negative</span>
                  <span data-testid="score-negative" className="text-lg font-bold text-red-500">
                    {reputation.negative_outcomes}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Interaction Timeline */}
        <Card className="mb-6">
          <CardContent className="p-6">
            <div data-testid="outcomes-section">
              <h2 className="text-lg font-bold text-foreground mt-0 mb-4">Interaction History</h2>
              {outcomes.length === 0 ? (
                <div data-testid="outcomes-empty" className="text-muted-foreground text-center py-8">
                  No interactions recorded yet.
                </div>
              ) : (
                <div data-testid="outcomes-list" className="flex flex-col gap-2">
                  {outcomes.map((outcome) => (
                    <div
                      key={outcome.outcome_id}
                      data-testid={`outcome-${outcome.outcome_id}`}
                      className="flex items-center gap-3 px-3 py-2 bg-background rounded-md border border-border flex-wrap"
                    >
                      <span
                        data-testid={`outcome-type-${outcome.outcome_id}`}
                        className="px-1.5 py-0.5 rounded text-[0.7rem] font-semibold capitalize"
                        style={{
                          color: outcome.outcome_type === "positive"
                            ? "#22c55e"
                            : outcome.outcome_type === "negative"
                              ? "#ef4444"
                              : "#94a3b8",
                          backgroundColor: outcome.outcome_type === "positive"
                            ? "#052e16"
                            : outcome.outcome_type === "negative"
                              ? "#450a0a"
                              : "#1e293b",
                        }}
                      >
                        {outcome.outcome_type}
                      </span>
                      <span className="text-sm text-foreground flex-1 min-w-[150px]">{outcome.description}</span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(outcome.occurred_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Drift Report View
  // -------------------------------------------------------------------------

  if (view === "drift") {
    if (driftLoading) {
      return (
        <div data-testid="drift-loading" className="mx-auto max-w-[1200px]">
          <h1 className="text-2xl font-bold text-foreground m-0">Relationships</h1>
          <p className="text-muted-foreground text-center py-8">Loading drift report...</p>
        </div>
      );
    }

    const sortedEntries = driftReport
      ? sortByDriftSeverity(driftReport.entries)
      : [];

    return (
      <div className="mx-auto max-w-[1200px]">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h1 className="text-2xl font-bold text-foreground m-0">Drift Report</h1>
          <Button
            data-testid="back-to-list-btn"
            onClick={() => setView("list")}
            variant="outline"
            className="border-border text-muted-foreground"
          >
            Back to List
          </Button>
        </div>

        {statusMsg && (
          <div
            data-testid="relationships-status-msg"
            className={`px-4 py-2 rounded-md text-sm font-medium mb-4 border ${
              statusMsg.type === "success"
                ? "bg-emerald-950 text-emerald-300 border-emerald-600"
                : "bg-red-950 text-red-300 border-red-700"
            }`}
          >
            {statusMsg.text}
          </div>
        )}

        <Card data-testid="drift-report">
          <CardContent className="p-6">
            <h2 className="text-lg font-bold text-foreground mt-0 mb-4">Overdue Contacts</h2>
            {sortedEntries.length === 0 ? (
              <div data-testid="drift-empty" className="text-muted-foreground text-center py-8">
                No overdue contacts. All relationships are on track.
              </div>
            ) : (
              <div data-testid="drift-entries" className="flex flex-col gap-2">
                {sortedEntries.map((entry) => {
                  const catSt = categoryStyle(entry.category);
                  return (
                    <div
                      key={entry.relationship_id}
                      data-testid={`drift-entry-${entry.relationship_id}`}
                      className="flex justify-between items-center px-4 py-3 bg-background rounded-lg border border-border flex-wrap gap-2"
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-[150px]">
                        <span
                          data-testid={`drift-name-${entry.relationship_id}`}
                          className="text-sm text-foreground font-semibold"
                        >
                          {entry.name}
                        </span>
                        <span
                          className="px-1.5 py-0.5 rounded text-[0.7rem] font-semibold whitespace-nowrap"
                          style={{
                            color: catSt.color,
                            backgroundColor: catSt.bg,
                          }}
                        >
                          {categoryLabel(entry.category)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap">
                        <span
                          data-testid={`drift-indicator-${entry.relationship_id}`}
                          className="px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap"
                          style={{
                            color: driftColor(entry.drift_level),
                            backgroundColor: driftBgColor(entry.drift_level),
                          }}
                        >
                          {driftLabel(entry.drift_level)}
                        </span>
                        <span
                          data-testid={`drift-days-${entry.relationship_id}`}
                          className="text-xs font-semibold text-red-300"
                        >
                          {entry.days_overdue} days overdue
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Last: {formatDate(entry.last_interaction)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Contact List View (default)
  // -------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-foreground m-0">Relationships</h1>
        <div className="flex gap-3 items-center flex-wrap">
          <a
            href="#/reconnections"
            data-testid="reconnections-link"
            className="px-4 py-2 rounded-md border border-violet-500 text-violet-500 text-sm font-semibold no-underline hover:bg-violet-500/10"
          >
            Reconnections
          </a>
          <Button
            data-testid="drift-report-btn"
            onClick={openDriftReport}
            variant="outline"
            className="border-yellow-500 text-yellow-500 font-semibold hover:bg-yellow-500/10"
          >
            Drift Report
          </Button>
          <Button
            data-testid="add-relationship-btn"
            onClick={() => setView("add")}
          >
            Add Relationship
          </Button>
          <a href="#/calendar" className="text-muted-foreground text-sm no-underline hover:text-foreground">
            Back to Calendar
          </a>
        </div>
      </div>

      {statusMsg && (
        <div
          data-testid="relationships-status-msg"
          className={`px-4 py-2 rounded-md text-sm font-medium mb-4 border ${
            statusMsg.type === "success"
              ? "bg-emerald-950 text-emerald-300 border-emerald-600"
              : "bg-red-950 text-red-300 border-red-700"
          }`}
        >
          {statusMsg.text}
        </div>
      )}

      <Card data-testid="contact-list">
        <CardContent className="p-6">
          <h2 className="text-lg font-bold text-foreground mt-0 mb-4">Contacts</h2>
          {relationships.length === 0 ? (
            <div data-testid="list-empty" className="text-muted-foreground text-center py-8">
              No relationships yet. Add one to get started.
            </div>
          ) : (
            <div data-testid="contact-rows" className="flex flex-col gap-2">
              {relationships.map((rel) => {
                const catSt = categoryStyle(rel.category);
                return (
                  <div
                    key={rel.id}
                    data-testid={`contact-row-${rel.id}`}
                    className="flex items-center gap-4 px-4 py-3 bg-background rounded-lg border border-border cursor-pointer flex-wrap transition-colors hover:border-primary/50"
                    onClick={() => openDetail(rel.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") openDetail(rel.id);
                    }}
                  >
                    <div className="flex flex-col gap-0.5 flex-1 min-w-[150px]">
                      <span
                        data-testid={`contact-name-${rel.id}`}
                        className="text-sm text-foreground font-semibold"
                      >
                        {rel.name}
                      </span>
                      <span className="text-xs text-muted-foreground">{rel.email}</span>
                    </div>
                    <span
                      data-testid={`category-badge-${rel.id}`}
                      className="px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap"
                      style={{
                        color: catSt.color,
                        backgroundColor: catSt.bg,
                      }}
                    >
                      {categoryLabel(rel.category)}
                    </span>
                    <span
                      data-testid={`drift-badge-${rel.id}`}
                      className="px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap"
                      style={{
                        color: driftColor(rel.drift_level),
                        backgroundColor: driftBgColor(rel.drift_level),
                      }}
                    >
                      {driftLabel(rel.drift_level)}
                    </span>
                    <span
                      data-testid={`last-interaction-${rel.id}`}
                      className="text-xs text-muted-foreground whitespace-nowrap"
                    >
                      {formatDate(rel.last_interaction)}
                    </span>
                    <span
                      data-testid={`reliability-${rel.id}`}
                      className="text-xs font-semibold text-primary whitespace-nowrap"
                    >
                      {formatScore(rel.reliability_score)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
