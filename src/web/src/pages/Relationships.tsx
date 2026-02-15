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
 * The component accepts fetch/action functions as props for testability.
 * In production, these are wired to the API client with auth tokens in App.tsx.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  Relationship,
  CreateRelationshipPayload,
  UpdateRelationshipPayload,
  ReputationScores,
  Outcome,
  CreateOutcomePayload,
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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RelationshipsProps {
  /** Fetch all relationships. */
  fetchRelationships: () => Promise<Relationship[]>;
  /** Create a new relationship. */
  createRelationship: (payload: CreateRelationshipPayload) => Promise<Relationship>;
  /** Fetch a single relationship by ID. */
  fetchRelationship: (id: string) => Promise<Relationship>;
  /** Update an existing relationship. */
  updateRelationship: (id: string, payload: UpdateRelationshipPayload) => Promise<Relationship>;
  /** Delete a relationship. */
  deleteRelationship: (id: string) => Promise<void>;
  /** Fetch reputation scores for a relationship. */
  fetchReputation: (id: string) => Promise<ReputationScores>;
  /** Fetch outcomes for a relationship. */
  fetchOutcomes: (relationshipId: string) => Promise<Outcome[]>;
  /** Create an outcome for a relationship. */
  createOutcome: (relationshipId: string, payload: CreateOutcomePayload) => Promise<Outcome>;
  /** Fetch drift report. */
  fetchDriftReport: () => Promise<DriftReport>;
}

// ---------------------------------------------------------------------------
// View type
// ---------------------------------------------------------------------------

type ViewMode = "list" | "detail" | "drift" | "add";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Relationships({
  fetchRelationships,
  createRelationship,
  fetchRelationship,
  updateRelationship,
  deleteRelationship,
  fetchReputation,
  fetchOutcomes,
  createOutcome,
  fetchDriftReport,
}: RelationshipsProps) {
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
      const result = await fetchRelationships();
      if (!mountedRef.current) return;
      setRelationships(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [fetchRelationships]);

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
          fetchRelationship(id),
          fetchReputation(id),
          fetchOutcomes(id),
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
    [fetchRelationship, fetchReputation, fetchOutcomes, showStatus],
  );

  // -------------------------------------------------------------------------
  // CRUD handlers
  // -------------------------------------------------------------------------

  const handleCreate = useCallback(async () => {
    if (!formName.trim() || !formEmail.trim()) return;

    setSubmitting(true);
    try {
      await createRelationship({
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
    createRelationship, loadRelationships, showStatus,
  ]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteRelationship(id);
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
    [deleteRelationship, loadRelationships, showStatus],
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
      const updated = await updateRelationship(selectedId, {
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
    updateRelationship, loadRelationships, showStatus,
  ]);

  // -------------------------------------------------------------------------
  // Drift report handler
  // -------------------------------------------------------------------------

  const openDriftReport = useCallback(async () => {
    setView("drift");
    setDriftLoading(true);
    try {
      const report = await fetchDriftReport();
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
  }, [fetchDriftReport, showStatus]);

  // -------------------------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div data-testid="relationships-loading" style={styles.container}>
        <h1 style={styles.title}>Relationships</h1>
        <div style={styles.loading}>Loading relationships...</div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Error
  // -------------------------------------------------------------------------

  if (error) {
    return (
      <div data-testid="relationships-error" style={styles.container}>
        <h1 style={styles.title}>Relationships</h1>
        <div style={styles.errorBox}>
          <p>Failed to load relationships: {error}</p>
          <button
            onClick={async () => {
              setLoading(true);
              setError(null);
              await loadRelationships();
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
  // Render: Add Form View
  // -------------------------------------------------------------------------

  if (view === "add") {
    return (
      <div style={styles.container}>
        <div style={styles.headerRow}>
          <h1 style={styles.title}>Add Relationship</h1>
          <button
            data-testid="back-to-list-btn"
            onClick={() => setView("list")}
            style={styles.backBtn}
          >
            Back to List
          </button>
        </div>

        {statusMsg && (
          <div
            data-testid="relationships-status-msg"
            style={{
              ...styles.statusMessage,
              ...(statusMsg.type === "success" ? styles.statusSuccess : styles.statusError),
            }}
          >
            {statusMsg.text}
          </div>
        )}

        <div data-testid="add-form" style={styles.card}>
          <h2 style={styles.sectionTitle}>New Relationship</h2>
          <div style={styles.formGrid}>
            <div style={styles.formGroup}>
              <label htmlFor="rel-name" style={styles.label}>Name</label>
              <input
                id="rel-name"
                data-testid="form-name-input"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Contact name"
                style={styles.input}
              />
            </div>
            <div style={styles.formGroup}>
              <label htmlFor="rel-email" style={styles.label}>Email</label>
              <input
                id="rel-email"
                data-testid="form-email-input"
                type="email"
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                placeholder="contact@example.com"
                style={styles.input}
              />
            </div>
            <div style={styles.formGroup}>
              <label htmlFor="rel-category" style={styles.label}>Category</label>
              <select
                id="rel-category"
                data-testid="form-category-select"
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value as RelationshipCategory)}
                style={styles.input}
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {categoryLabel(cat)}
                  </option>
                ))}
              </select>
            </div>
            <div style={styles.formGroup}>
              <label htmlFor="rel-city" style={styles.label}>City</label>
              <input
                id="rel-city"
                data-testid="form-city-input"
                type="text"
                value={formCity}
                onChange={(e) => setFormCity(e.target.value)}
                placeholder="San Francisco"
                style={styles.input}
              />
            </div>
            <div style={styles.formGroup}>
              <label htmlFor="rel-timezone" style={styles.label}>Timezone</label>
              <input
                id="rel-timezone"
                data-testid="form-timezone-input"
                type="text"
                value={formTimezone}
                onChange={(e) => setFormTimezone(e.target.value)}
                placeholder="America/Los_Angeles"
                style={styles.input}
              />
            </div>
            <div style={styles.formGroup}>
              <label htmlFor="rel-frequency" style={styles.label}>Contact Frequency</label>
              <select
                id="rel-frequency"
                data-testid="form-frequency-select"
                value={formFrequency}
                onChange={(e) => setFormFrequency(Number(e.target.value))}
                style={styles.input}
              >
                {FREQUENCY_OPTIONS.map((opt) => (
                  <option key={opt.days} value={opt.days}>
                    {opt.label} ({opt.days} days)
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            data-testid="submit-create-btn"
            onClick={handleCreate}
            disabled={submitting || !formName.trim() || !formEmail.trim()}
            style={{
              ...styles.addBtn,
              opacity: submitting || !formName.trim() || !formEmail.trim() ? 0.5 : 1,
              cursor: submitting || !formName.trim() || !formEmail.trim() ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Creating..." : "Create Relationship"}
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Detail View
  // -------------------------------------------------------------------------

  if (view === "detail") {
    if (detailLoading) {
      return (
        <div data-testid="detail-loading" style={styles.container}>
          <h1 style={styles.title}>Relationships</h1>
          <div style={styles.loading}>Loading contact details...</div>
        </div>
      );
    }

    if (!detailRelationship) {
      return (
        <div style={styles.container}>
          <h1 style={styles.title}>Relationships</h1>
          <div style={styles.loading}>Contact not found.</div>
        </div>
      );
    }

    const catStyle = categoryStyle(detailRelationship.category);

    return (
      <div style={styles.container}>
        <div style={styles.headerRow}>
          <h1 style={styles.title}>Relationships</h1>
          <button
            data-testid="back-to-list-btn"
            onClick={() => setView("list")}
            style={styles.backBtn}
          >
            Back to List
          </button>
        </div>

        {statusMsg && (
          <div
            data-testid="relationships-status-msg"
            style={{
              ...styles.statusMessage,
              ...(statusMsg.type === "success" ? styles.statusSuccess : styles.statusError),
            }}
          >
            {statusMsg.text}
          </div>
        )}

        {/* Contact Profile */}
        <div data-testid="contact-detail" style={styles.card}>
          <div style={styles.detailHeader}>
            <div>
              <h2 data-testid="detail-name" style={styles.detailName}>
                {detailRelationship.name}
              </h2>
              <span data-testid="detail-email" style={styles.detailEmail}>
                {detailRelationship.email}
              </span>
            </div>
            <div style={styles.detailActions}>
              <button
                data-testid="edit-btn"
                onClick={startEditing}
                style={styles.editBtn}
              >
                Edit
              </button>
              <button
                data-testid="delete-btn"
                onClick={() => handleDelete(detailRelationship.id)}
                style={styles.removeBtn}
              >
                Delete
              </button>
            </div>
          </div>

          <div style={styles.detailMeta}>
            <span
              data-testid="detail-category"
              style={{
                ...styles.badge,
                color: catStyle.color,
                backgroundColor: catStyle.bg,
              }}
            >
              {categoryLabel(detailRelationship.category)}
            </span>
            <span
              data-testid="detail-drift"
              style={{
                ...styles.badge,
                color: driftColor(detailRelationship.drift_level),
                backgroundColor: driftBgColor(detailRelationship.drift_level),
              }}
            >
              {driftLabel(detailRelationship.drift_level)}
            </span>
            <span style={styles.metaText}>
              {detailRelationship.city}
              {detailRelationship.timezone && ` (${detailRelationship.timezone})`}
            </span>
            <span style={styles.metaText}>
              Frequency: every {detailRelationship.frequency_days} days
            </span>
            <span style={styles.metaText}>
              Last interaction: {formatDate(detailRelationship.last_interaction)}
            </span>
          </div>

          {/* Edit Form (inline) */}
          {editing && (
            <div data-testid="edit-form" style={styles.editForm}>
              <h3 style={styles.subsectionTitle}>Edit Relationship</h3>
              <div style={styles.formGrid}>
                <div style={styles.formGroup}>
                  <label htmlFor="edit-name" style={styles.label}>Name</label>
                  <input
                    id="edit-name"
                    data-testid="edit-name-input"
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    style={styles.input}
                  />
                </div>
                <div style={styles.formGroup}>
                  <label htmlFor="edit-email" style={styles.label}>Email</label>
                  <input
                    id="edit-email"
                    data-testid="edit-email-input"
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    style={styles.input}
                  />
                </div>
                <div style={styles.formGroup}>
                  <label htmlFor="edit-category" style={styles.label}>Category</label>
                  <select
                    id="edit-category"
                    data-testid="edit-category-select"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value as RelationshipCategory)}
                    style={styles.input}
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {categoryLabel(cat)}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={styles.formGroup}>
                  <label htmlFor="edit-city" style={styles.label}>City</label>
                  <input
                    id="edit-city"
                    data-testid="edit-city-input"
                    type="text"
                    value={editCity}
                    onChange={(e) => setEditCity(e.target.value)}
                    style={styles.input}
                  />
                </div>
                <div style={styles.formGroup}>
                  <label htmlFor="edit-timezone" style={styles.label}>Timezone</label>
                  <input
                    id="edit-timezone"
                    data-testid="edit-timezone-input"
                    type="text"
                    value={editTimezone}
                    onChange={(e) => setEditTimezone(e.target.value)}
                    style={styles.input}
                  />
                </div>
                <div style={styles.formGroup}>
                  <label htmlFor="edit-frequency" style={styles.label}>Frequency</label>
                  <select
                    id="edit-frequency"
                    data-testid="edit-frequency-select"
                    value={editFrequency}
                    onChange={(e) => setEditFrequency(Number(e.target.value))}
                    style={styles.input}
                  >
                    {FREQUENCY_OPTIONS.map((opt) => (
                      <option key={opt.days} value={opt.days}>
                        {opt.label} ({opt.days} days)
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={styles.editActions}>
                <button
                  data-testid="save-edit-btn"
                  onClick={handleUpdate}
                  disabled={submitting || !editName.trim() || !editEmail.trim()}
                  style={{
                    ...styles.addBtn,
                    opacity: submitting ? 0.5 : 1,
                  }}
                >
                  {submitting ? "Saving..." : "Save Changes"}
                </button>
                <button
                  data-testid="cancel-edit-btn"
                  onClick={() => setEditing(false)}
                  style={styles.backBtn}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Reputation Scores */}
        {reputation && (
          <div data-testid="reputation-section" style={styles.card}>
            <h2 style={styles.sectionTitle}>Reputation Scores</h2>
            <div data-testid="reputation-scores" style={styles.scoresGrid}>
              <div style={styles.scoreCard}>
                <span style={styles.scoreLabel}>Overall</span>
                <span data-testid="score-overall" style={styles.scoreValue}>
                  {formatScore(reputation.overall_score)}
                </span>
              </div>
              <div style={styles.scoreCard}>
                <span style={styles.scoreLabel}>Reliability</span>
                <span data-testid="score-reliability" style={styles.scoreValue}>
                  {formatScore(reputation.reliability_score)}
                </span>
              </div>
              <div style={styles.scoreCard}>
                <span style={styles.scoreLabel}>Responsiveness</span>
                <span data-testid="score-responsiveness" style={styles.scoreValue}>
                  {formatScore(reputation.responsiveness_score)}
                </span>
              </div>
              <div style={styles.scoreCard}>
                <span style={styles.scoreLabel}>Follow-through</span>
                <span data-testid="score-follow-through" style={styles.scoreValue}>
                  {formatScore(reputation.follow_through_score)}
                </span>
              </div>
              <div style={styles.scoreCard}>
                <span style={styles.scoreLabel}>Interactions</span>
                <span data-testid="score-interactions" style={styles.scoreValue}>
                  {reputation.total_interactions}
                </span>
              </div>
              <div style={styles.scoreCard}>
                <span style={styles.scoreLabel}>Positive</span>
                <span data-testid="score-positive" style={{ ...styles.scoreValue, color: "#22c55e" }}>
                  {reputation.positive_outcomes}
                </span>
              </div>
              <div style={styles.scoreCard}>
                <span style={styles.scoreLabel}>Negative</span>
                <span data-testid="score-negative" style={{ ...styles.scoreValue, color: "#ef4444" }}>
                  {reputation.negative_outcomes}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Interaction Timeline */}
        <div data-testid="outcomes-section" style={styles.card}>
          <h2 style={styles.sectionTitle}>Interaction History</h2>
          {outcomes.length === 0 ? (
            <div data-testid="outcomes-empty" style={styles.emptyState}>
              No interactions recorded yet.
            </div>
          ) : (
            <div data-testid="outcomes-list" style={styles.outcomesList}>
              {outcomes.map((outcome) => (
                <div
                  key={outcome.outcome_id}
                  data-testid={`outcome-${outcome.outcome_id}`}
                  style={styles.outcomeRow}
                >
                  <span
                    data-testid={`outcome-type-${outcome.outcome_id}`}
                    style={{
                      ...styles.outcomeBadge,
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
                  <span style={styles.outcomeDesc}>{outcome.description}</span>
                  <span style={styles.outcomeDate}>{formatDate(outcome.occurred_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Drift Report View
  // -------------------------------------------------------------------------

  if (view === "drift") {
    if (driftLoading) {
      return (
        <div data-testid="drift-loading" style={styles.container}>
          <h1 style={styles.title}>Relationships</h1>
          <div style={styles.loading}>Loading drift report...</div>
        </div>
      );
    }

    const sortedEntries = driftReport
      ? sortByDriftSeverity(driftReport.entries)
      : [];

    return (
      <div style={styles.container}>
        <div style={styles.headerRow}>
          <h1 style={styles.title}>Drift Report</h1>
          <button
            data-testid="back-to-list-btn"
            onClick={() => setView("list")}
            style={styles.backBtn}
          >
            Back to List
          </button>
        </div>

        {statusMsg && (
          <div
            data-testid="relationships-status-msg"
            style={{
              ...styles.statusMessage,
              ...(statusMsg.type === "success" ? styles.statusSuccess : styles.statusError),
            }}
          >
            {statusMsg.text}
          </div>
        )}

        <div data-testid="drift-report" style={styles.card}>
          <h2 style={styles.sectionTitle}>Overdue Contacts</h2>
          {sortedEntries.length === 0 ? (
            <div data-testid="drift-empty" style={styles.emptyState}>
              No overdue contacts. All relationships are on track.
            </div>
          ) : (
            <div data-testid="drift-entries" style={styles.driftList}>
              {sortedEntries.map((entry) => {
                const catSt = categoryStyle(entry.category);
                return (
                  <div
                    key={entry.relationship_id}
                    data-testid={`drift-entry-${entry.relationship_id}`}
                    style={styles.driftRow}
                  >
                    <div style={styles.driftInfo}>
                      <span
                        data-testid={`drift-name-${entry.relationship_id}`}
                        style={styles.driftName}
                      >
                        {entry.name}
                      </span>
                      <span
                        style={{
                          ...styles.smallBadge,
                          color: catSt.color,
                          backgroundColor: catSt.bg,
                        }}
                      >
                        {categoryLabel(entry.category)}
                      </span>
                    </div>
                    <div style={styles.driftMeta}>
                      <span
                        data-testid={`drift-indicator-${entry.relationship_id}`}
                        style={{
                          ...styles.badge,
                          color: driftColor(entry.drift_level),
                          backgroundColor: driftBgColor(entry.drift_level),
                        }}
                      >
                        {driftLabel(entry.drift_level)}
                      </span>
                      <span
                        data-testid={`drift-days-${entry.relationship_id}`}
                        style={styles.driftDays}
                      >
                        {entry.days_overdue} days overdue
                      </span>
                      <span style={styles.metaText}>
                        Last: {formatDate(entry.last_interaction)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Contact List View (default)
  // -------------------------------------------------------------------------

  return (
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Relationships</h1>
        <div style={styles.headerActions}>
          <button
            data-testid="drift-report-btn"
            onClick={openDriftReport}
            style={styles.driftReportBtn}
          >
            Drift Report
          </button>
          <button
            data-testid="add-relationship-btn"
            onClick={() => setView("add")}
            style={styles.addBtn}
          >
            Add Relationship
          </button>
          <a href="#/calendar" style={styles.backLink}>
            Back to Calendar
          </a>
        </div>
      </div>

      {statusMsg && (
        <div
          data-testid="relationships-status-msg"
          style={{
            ...styles.statusMessage,
            ...(statusMsg.type === "success" ? styles.statusSuccess : styles.statusError),
          }}
        >
          {statusMsg.text}
        </div>
      )}

      <div data-testid="contact-list" style={styles.card}>
        <h2 style={styles.sectionTitle}>Contacts</h2>
        {relationships.length === 0 ? (
          <div data-testid="list-empty" style={styles.emptyState}>
            No relationships yet. Add one to get started.
          </div>
        ) : (
          <div data-testid="contact-rows" style={styles.contactList}>
            {relationships.map((rel) => {
              const catSt = categoryStyle(rel.category);
              return (
                <div
                  key={rel.id}
                  data-testid={`contact-row-${rel.id}`}
                  style={styles.contactRow}
                  onClick={() => openDetail(rel.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") openDetail(rel.id);
                  }}
                >
                  <div style={styles.contactInfo}>
                    <span
                      data-testid={`contact-name-${rel.id}`}
                      style={styles.contactName}
                    >
                      {rel.name}
                    </span>
                    <span style={styles.contactEmail}>{rel.email}</span>
                  </div>
                  <span
                    data-testid={`category-badge-${rel.id}`}
                    style={{
                      ...styles.badge,
                      color: catSt.color,
                      backgroundColor: catSt.bg,
                    }}
                  >
                    {categoryLabel(rel.category)}
                  </span>
                  <span
                    data-testid={`drift-badge-${rel.id}`}
                    style={{
                      ...styles.badge,
                      color: driftColor(rel.drift_level),
                      backgroundColor: driftBgColor(rel.drift_level),
                    }}
                  >
                    {driftLabel(rel.drift_level)}
                  </span>
                  <span
                    data-testid={`last-interaction-${rel.id}`}
                    style={styles.lastInteraction}
                  >
                    {formatDate(rel.last_interaction)}
                  </span>
                  <span
                    data-testid={`reliability-${rel.id}`}
                    style={styles.reliabilityScore}
                  >
                    {formatScore(rel.reliability_score)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (consistent with Governance.tsx / Scheduling.tsx patterns)
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
  backBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #475569",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.875rem",
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
  statusMessage: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    fontSize: "0.875rem",
    fontWeight: 500,
    marginBottom: "1rem",
  },
  statusSuccess: {
    backgroundColor: "#064e3b",
    color: "#6ee7b7",
    border: "1px solid #059669",
  },
  statusError: {
    backgroundColor: "#450a0a",
    color: "#fca5a5",
    border: "1px solid #dc2626",
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
  subsectionTitle: {
    fontSize: "0.95rem",
    fontWeight: 600,
    color: "#e2e8f0",
    marginTop: "1.5rem",
    marginBottom: "0.75rem",
  },

  // -- Contact List --
  contactList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
  },
  contactRow: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "0.75rem 1rem",
    backgroundColor: "#0f172a",
    borderRadius: "8px",
    border: "1px solid #334155",
    cursor: "pointer",
    flexWrap: "wrap" as const,
    transition: "border-color 0.2s",
  },
  contactInfo: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.15rem",
    flex: 1,
    minWidth: "150px",
  },
  contactName: {
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 600,
  },
  contactEmail: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  badge: {
    padding: "0.2rem 0.5rem",
    borderRadius: "4px",
    fontSize: "0.75rem",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  smallBadge: {
    padding: "0.15rem 0.4rem",
    borderRadius: "3px",
    fontSize: "0.7rem",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  lastInteraction: {
    fontSize: "0.8rem",
    color: "#94a3b8",
    whiteSpace: "nowrap" as const,
  },
  reliabilityScore: {
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "#3b82f6",
    whiteSpace: "nowrap" as const,
  },

  // -- Form --
  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: "1rem",
    marginBottom: "1rem",
  },
  formGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.35rem",
  },
  label: {
    display: "block",
    fontSize: "0.8rem",
    color: "#94a3b8",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  input: {
    padding: "0.5rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #475569",
    backgroundColor: "#0f172a",
    color: "#e2e8f0",
    fontSize: "0.875rem",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  addBtn: {
    padding: "0.5rem 1.25rem",
    borderRadius: "6px",
    border: "none",
    backgroundColor: "#3b82f6",
    color: "#ffffff",
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  driftReportBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #eab308",
    background: "transparent",
    color: "#eab308",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 600,
  },

  // -- Detail View --
  detailHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: "1rem",
    flexWrap: "wrap" as const,
    gap: "0.5rem",
  },
  detailName: {
    fontSize: "1.25rem",
    fontWeight: 700,
    color: "#f1f5f9",
    margin: 0,
  },
  detailEmail: {
    fontSize: "0.875rem",
    color: "#94a3b8",
  },
  detailActions: {
    display: "flex",
    gap: "0.5rem",
  },
  detailMeta: {
    display: "flex",
    gap: "0.75rem",
    flexWrap: "wrap" as const,
    alignItems: "center",
  },
  metaText: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  editBtn: {
    padding: "0.35rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #3b82f6",
    background: "transparent",
    color: "#3b82f6",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  removeBtn: {
    padding: "0.35rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.8rem",
  },
  editForm: {
    marginTop: "1.5rem",
    borderTop: "1px solid #334155",
    paddingTop: "1rem",
  },
  editActions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "0.5rem",
  },

  // -- Scores --
  scoresGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
    gap: "0.75rem",
  },
  scoreCard: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    padding: "0.75rem",
    backgroundColor: "#0f172a",
    borderRadius: "8px",
    border: "1px solid #334155",
  },
  scoreLabel: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    marginBottom: "0.35rem",
  },
  scoreValue: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "#e2e8f0",
  },

  // -- Outcomes --
  outcomesList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
  },
  outcomeRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.5rem 0.75rem",
    backgroundColor: "#0f172a",
    borderRadius: "6px",
    border: "1px solid #334155",
    flexWrap: "wrap" as const,
  },
  outcomeBadge: {
    padding: "0.15rem 0.4rem",
    borderRadius: "3px",
    fontSize: "0.7rem",
    fontWeight: 600,
    textTransform: "capitalize" as const,
  },
  outcomeDesc: {
    fontSize: "0.85rem",
    color: "#e2e8f0",
    flex: 1,
    minWidth: "150px",
  },
  outcomeDate: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    whiteSpace: "nowrap" as const,
  },

  // -- Drift Report --
  driftList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
  },
  driftRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.75rem 1rem",
    backgroundColor: "#0f172a",
    borderRadius: "8px",
    border: "1px solid #334155",
    flexWrap: "wrap" as const,
    gap: "0.5rem",
  },
  driftInfo: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flex: 1,
    minWidth: "150px",
  },
  driftName: {
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 600,
  },
  driftMeta: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    flexWrap: "wrap" as const,
  },
  driftDays: {
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "#fca5a5",
  },
};
