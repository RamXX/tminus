/**
 * Governance Dashboard page.
 *
 * Provides a UI for commitment compliance tracking, VIP list management,
 * time allocation overview, and export proof functionality.
 *
 * Features:
 * - Chart: actual vs target hours per client with compliance color coding
 * - VIP list: add/remove VIP contacts
 * - Time allocation: weekly or monthly view toggle
 * - Export proof: per-commitment export button with download link
 *
 * Color coding:
 *   compliant = green (#22c55e)
 *   under target = yellow (#eab308)
 *   over target = blue (#3b82f6)
 *
 * The component accepts fetch/action functions as props for testability.
 * In production, these are wired to the API client with auth tokens in App.tsx.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  Commitment,
  VipContact,
  AddVipPayload,
  ExportProofResponse,
  AllocationViewMode,
} from "../lib/governance";
import {
  toChartData,
  chartMaxHours,
  barPercent,
  complianceColor,
  complianceBgColor,
  complianceLabel,
  aggregateTimeAllocations,
  formatHours,
} from "../lib/governance";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GovernanceProps {
  /** Fetch all commitments for the current user. */
  fetchCommitments: () => Promise<Commitment[]>;
  /** Fetch VIP contact list. */
  fetchVips: () => Promise<VipContact[]>;
  /** Add a new VIP contact. */
  addVip: (payload: AddVipPayload) => Promise<VipContact>;
  /** Remove a VIP contact. */
  removeVip: (vipId: string) => Promise<void>;
  /** Export proof for a commitment. */
  exportProof: (commitmentId: string) => Promise<ExportProofResponse>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Governance({
  fetchCommitments,
  fetchVips,
  addVip,
  removeVip,
  exportProof,
}: GovernanceProps) {
  // -- State: data --
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [vips, setVips] = useState<VipContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- State: VIP form --
  const [vipName, setVipName] = useState("");
  const [vipEmail, setVipEmail] = useState("");
  const [vipNotes, setVipNotes] = useState("");
  const [addingVip, setAddingVip] = useState(false);

  // -- State: time allocation view --
  const [allocationMode, setAllocationMode] = useState<AllocationViewMode>("weekly");

  // -- State: export --
  const [exportLinks, setExportLinks] = useState<Record<string, ExportProofResponse>>({});
  const [exportingId, setExportingId] = useState<string | null>(null);

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

  const loadCommitments = useCallback(async () => {
    try {
      const result = await fetchCommitments();
      if (!mountedRef.current) return;
      setCommitments(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [fetchCommitments]);

  const loadVips = useCallback(async () => {
    try {
      const result = await fetchVips();
      if (!mountedRef.current) return;
      setVips(result);
    } catch {
      // Non-critical -- VIP list will be empty
    }
  }, [fetchVips]);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function load() {
      await Promise.all([loadCommitments(), loadVips()]);
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
  }, [loadCommitments, loadVips]);

  // -------------------------------------------------------------------------
  // VIP handlers
  // -------------------------------------------------------------------------

  const handleAddVip = useCallback(async () => {
    if (!vipName.trim() || !vipEmail.trim()) return;

    setAddingVip(true);
    try {
      await addVip({ name: vipName.trim(), email: vipEmail.trim(), notes: vipNotes.trim() });
      if (!mountedRef.current) return;
      showStatus("success", "VIP contact added.");
      setVipName("");
      setVipEmail("");
      setVipNotes("");
      await loadVips();
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to add VIP: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      if (mountedRef.current) setAddingVip(false);
    }
  }, [vipName, vipEmail, vipNotes, addVip, loadVips, showStatus]);

  const handleRemoveVip = useCallback(
    async (vipId: string) => {
      try {
        await removeVip(vipId);
        if (!mountedRef.current) return;
        showStatus("success", "VIP contact removed.");
        await loadVips();
      } catch (err) {
        if (!mountedRef.current) return;
        showStatus(
          "error",
          `Failed to remove VIP: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
    [removeVip, loadVips, showStatus],
  );

  // -------------------------------------------------------------------------
  // Export handler
  // -------------------------------------------------------------------------

  const handleExportProof = useCallback(
    async (commitmentId: string) => {
      setExportingId(commitmentId);
      try {
        const result = await exportProof(commitmentId);
        if (!mountedRef.current) return;
        setExportLinks((prev) => ({ ...prev, [commitmentId]: result }));
        showStatus("success", "Export proof generated.");
      } catch (err) {
        if (!mountedRef.current) return;
        showStatus(
          "error",
          `Failed to export: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      } finally {
        if (mountedRef.current) setExportingId(null);
      }
    },
    [exportProof, showStatus],
  );

  // -------------------------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div data-testid="governance-loading" style={styles.container}>
        <h1 style={styles.title}>Governance Dashboard</h1>
        <div style={styles.loading}>Loading governance data...</div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Error
  // -------------------------------------------------------------------------

  if (error) {
    return (
      <div data-testid="governance-error" style={styles.container}>
        <h1 style={styles.title}>Governance Dashboard</h1>
        <div style={styles.errorBox}>
          <p>Failed to load commitments: {error}</p>
          <button
            onClick={async () => {
              setLoading(true);
              setError(null);
              await loadCommitments();
              await loadVips();
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
  // Computed data
  // -------------------------------------------------------------------------

  const chartData = toChartData(commitments);
  const maxHours = chartMaxHours(chartData);
  const timeAllocations = aggregateTimeAllocations(commitments, allocationMode);

  // -------------------------------------------------------------------------
  // Render: Main
  // -------------------------------------------------------------------------

  return (
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Governance Dashboard</h1>
        <a href="#/calendar" style={styles.backLink}>
          Back to Calendar
        </a>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div
          data-testid="governance-status-msg"
          style={{
            ...styles.statusMessage,
            ...(statusMsg.type === "success"
              ? styles.statusSuccess
              : styles.statusError),
          }}
        >
          {statusMsg.text}
        </div>
      )}

      {/* ================================================================= */}
      {/* AC#1: Chart -- Actual vs Target Hours per Client                  */}
      {/* ================================================================= */}
      <div data-testid="compliance-chart" style={styles.card}>
        <h2 style={styles.sectionTitle}>Commitment Compliance</h2>

        {chartData.length === 0 ? (
          <div data-testid="chart-empty" style={styles.emptyState}>
            No commitments found.
          </div>
        ) : (
          <div data-testid="chart-bars" style={styles.chartContainer}>
            {chartData.map((point) => (
              <div
                key={point.client_name}
                data-testid={`chart-row-${point.client_name}`}
                style={styles.chartRow}
              >
                <div style={styles.chartLabel}>{point.client_name}</div>
                <div style={styles.chartBars}>
                  {/* Target bar (grey background) */}
                  <div style={styles.barContainer}>
                    <div
                      data-testid={`target-bar-${point.client_name}`}
                      style={{
                        ...styles.bar,
                        width: `${barPercent(point.target_hours, maxHours)}%`,
                        backgroundColor: "#475569",
                      }}
                    />
                    <span style={styles.barLabel}>
                      Target: {formatHours(point.target_hours)}
                    </span>
                  </div>
                  {/* Actual bar (compliance-colored) */}
                  <div style={styles.barContainer}>
                    <div
                      data-testid={`actual-bar-${point.client_name}`}
                      style={{
                        ...styles.bar,
                        width: `${barPercent(point.actual_hours, maxHours)}%`,
                        backgroundColor: complianceColor(point.compliance_status),
                      }}
                    />
                    <span style={styles.barLabel}>
                      Actual: {formatHours(point.actual_hours)}
                    </span>
                  </div>
                </div>
                {/* Compliance badge */}
                <div
                  data-testid={`compliance-badge-${point.client_name}`}
                  style={{
                    ...styles.complianceBadge,
                    color: complianceColor(point.compliance_status),
                    backgroundColor: complianceBgColor(point.compliance_status),
                  }}
                >
                  {complianceLabel(point.compliance_status)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* AC#4: Export proof button per commitment */}
        {commitments.length > 0 && (
          <div data-testid="export-section" style={styles.exportSection}>
            <h3 style={styles.subsectionTitle}>Export Proof</h3>
            {commitments.map((c) => (
              <div
                key={c.commitment_id}
                data-testid={`export-row-${c.commitment_id}`}
                style={styles.exportRow}
              >
                <span style={styles.exportClient}>{c.client_name}</span>
                <button
                  data-testid={`export-btn-${c.commitment_id}`}
                  onClick={() => handleExportProof(c.commitment_id)}
                  disabled={exportingId === c.commitment_id}
                  style={{
                    ...styles.exportBtn,
                    opacity: exportingId === c.commitment_id ? 0.5 : 1,
                  }}
                >
                  {exportingId === c.commitment_id ? "Exporting..." : "Export Proof"}
                </button>
                {exportLinks[c.commitment_id] && (
                  <a
                    data-testid={`download-link-${c.commitment_id}`}
                    href={exportLinks[c.commitment_id].download_url}
                    style={styles.downloadLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Download: {exportLinks[c.commitment_id].filename}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ================================================================= */}
      {/* AC#2: VIP List with Add/Remove                                    */}
      {/* ================================================================= */}
      <div data-testid="vip-section" style={styles.card}>
        <h2 style={styles.sectionTitle}>VIP Contacts</h2>

        {/* VIP Add Form */}
        <div data-testid="vip-form" style={styles.vipForm}>
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label htmlFor="vip-name" style={styles.label}>Name</label>
              <input
                id="vip-name"
                data-testid="vip-name-input"
                type="text"
                value={vipName}
                onChange={(e) => setVipName(e.target.value)}
                placeholder="Contact name"
                style={styles.input}
              />
            </div>
            <div style={styles.formGroup}>
              <label htmlFor="vip-email" style={styles.label}>Email</label>
              <input
                id="vip-email"
                data-testid="vip-email-input"
                type="email"
                value={vipEmail}
                onChange={(e) => setVipEmail(e.target.value)}
                placeholder="contact@example.com"
                style={styles.input}
              />
            </div>
            <div style={styles.formGroup}>
              <label htmlFor="vip-notes" style={styles.label}>Notes</label>
              <input
                id="vip-notes"
                data-testid="vip-notes-input"
                type="text"
                value={vipNotes}
                onChange={(e) => setVipNotes(e.target.value)}
                placeholder="Optional notes"
                style={styles.input}
              />
            </div>
          </div>
          <button
            data-testid="add-vip-btn"
            onClick={handleAddVip}
            disabled={addingVip || !vipName.trim() || !vipEmail.trim()}
            style={{
              ...styles.addBtn,
              opacity: addingVip || !vipName.trim() || !vipEmail.trim() ? 0.5 : 1,
              cursor: addingVip || !vipName.trim() || !vipEmail.trim() ? "not-allowed" : "pointer",
            }}
          >
            {addingVip ? "Adding..." : "Add VIP"}
          </button>
        </div>

        {/* VIP List */}
        {vips.length === 0 ? (
          <div data-testid="vip-empty" style={styles.emptyState}>
            No VIP contacts yet. Add one above.
          </div>
        ) : (
          <div data-testid="vip-list" style={styles.vipList}>
            {vips.map((vip) => (
              <div
                key={vip.vip_id}
                data-testid={`vip-row-${vip.vip_id}`}
                style={styles.vipRow}
              >
                <div style={styles.vipInfo}>
                  <span data-testid={`vip-name-${vip.vip_id}`} style={styles.vipName}>
                    {vip.name}
                  </span>
                  <span style={styles.vipEmail}>{vip.email}</span>
                  {vip.notes && (
                    <span style={styles.vipNotes}>{vip.notes}</span>
                  )}
                </div>
                <button
                  data-testid={`remove-vip-btn-${vip.vip_id}`}
                  onClick={() => handleRemoveVip(vip.vip_id)}
                  style={styles.removeBtn}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ================================================================= */}
      {/* AC#3: Weekly/Monthly Time Allocation View                         */}
      {/* ================================================================= */}
      <div data-testid="time-allocation-section" style={styles.card}>
        <div style={styles.allocationHeader}>
          <h2 style={styles.sectionTitle}>Time Allocation</h2>
          <div style={styles.viewToggle}>
            <button
              data-testid="view-weekly-btn"
              onClick={() => setAllocationMode("weekly")}
              style={{
                ...styles.toggleBtn,
                ...(allocationMode === "weekly" ? styles.toggleBtnActive : {}),
              }}
            >
              Weekly
            </button>
            <button
              data-testid="view-monthly-btn"
              onClick={() => setAllocationMode("monthly")}
              style={{
                ...styles.toggleBtn,
                ...(allocationMode === "monthly" ? styles.toggleBtnActive : {}),
              }}
            >
              Monthly
            </button>
          </div>
        </div>

        {timeAllocations.length === 0 ? (
          <div data-testid="allocation-empty" style={styles.emptyState}>
            No time allocation data available.
          </div>
        ) : (
          <div data-testid="allocation-periods">
            {timeAllocations.map((period) => (
              <div
                key={period.period_label}
                data-testid={`period-${period.period_label}`}
                style={styles.periodCard}
              >
                <div style={styles.periodHeader}>
                  <span style={styles.periodLabel}>{period.period_label}</span>
                  <span
                    data-testid={`period-total-${period.period_label}`}
                    style={styles.periodTotal}
                  >
                    Total: {formatHours(period.total_hours)}
                  </span>
                </div>
                <div style={styles.allocationList}>
                  {period.allocations.map((alloc) => (
                    <div
                      key={alloc.client_name}
                      data-testid={`allocation-${period.period_label}-${alloc.client_name}`}
                      style={styles.allocationRow}
                    >
                      <span style={styles.allocationClient}>{alloc.client_name}</span>
                      <span style={styles.allocationHours}>
                        {formatHours(alloc.hours)}
                      </span>
                    </div>
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
// Inline styles (consistent with Scheduling.tsx / Billing.tsx patterns)
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

  // -- Card layout --
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

  // -- Chart --
  chartContainer: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "1.5rem",
  },
  chartRow: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    flexWrap: "wrap" as const,
  },
  chartLabel: {
    width: "120px",
    minWidth: "120px",
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 500,
    textAlign: "right" as const,
  },
  chartBars: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.25rem",
    minWidth: "200px",
  },
  barContainer: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    height: "20px",
  },
  bar: {
    height: "16px",
    borderRadius: "3px",
    minWidth: "2px",
    transition: "width 0.3s ease",
  },
  barLabel: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    whiteSpace: "nowrap" as const,
  },
  complianceBadge: {
    padding: "0.2rem 0.5rem",
    borderRadius: "4px",
    fontSize: "0.75rem",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },

  // -- Export --
  exportSection: {
    borderTop: "1px solid #334155",
    marginTop: "1.5rem",
    paddingTop: "0.5rem",
  },
  exportRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.5rem 0",
    flexWrap: "wrap" as const,
  },
  exportClient: {
    fontSize: "0.875rem",
    color: "#e2e8f0",
    minWidth: "120px",
  },
  exportBtn: {
    padding: "0.35rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #3b82f6",
    background: "transparent",
    color: "#3b82f6",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  downloadLink: {
    fontSize: "0.8rem",
    color: "#6ee7b7",
    textDecoration: "underline",
  },

  // -- VIP --
  vipForm: {
    marginBottom: "1rem",
  },
  formRow: {
    display: "flex",
    gap: "1rem",
    flexWrap: "wrap" as const,
    marginBottom: "0.75rem",
  },
  formGroup: {
    flex: 1,
    minWidth: "150px",
  },
  label: {
    display: "block",
    fontSize: "0.8rem",
    color: "#94a3b8",
    marginBottom: "0.35rem",
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
  },
  vipList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
  },
  vipRow: {
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
  vipInfo: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.15rem",
    flex: 1,
    minWidth: 0,
  },
  vipName: {
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 600,
  },
  vipEmail: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  vipNotes: {
    fontSize: "0.75rem",
    color: "#64748b",
    fontStyle: "italic" as const,
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

  // -- Time Allocation --
  allocationHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1rem",
  },
  viewToggle: {
    display: "flex",
    gap: "0.25rem",
    borderRadius: "6px",
    overflow: "hidden",
    border: "1px solid #475569",
  },
  toggleBtn: {
    padding: "0.35rem 0.75rem",
    border: "none",
    backgroundColor: "#0f172a",
    color: "#94a3b8",
    fontSize: "0.8rem",
    fontWeight: 500,
    cursor: "pointer",
  },
  toggleBtnActive: {
    backgroundColor: "#3b82f6",
    color: "#ffffff",
  },
  periodCard: {
    backgroundColor: "#0f172a",
    borderRadius: "8px",
    border: "1px solid #334155",
    padding: "1rem",
    marginBottom: "0.75rem",
  },
  periodHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "0.75rem",
  },
  periodLabel: {
    fontSize: "0.9rem",
    fontWeight: 600,
    color: "#e2e8f0",
  },
  periodTotal: {
    fontSize: "0.875rem",
    fontWeight: 700,
    color: "#3b82f6",
  },
  allocationList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.25rem",
  },
  allocationRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.35rem 0.5rem",
    borderRadius: "4px",
  },
  allocationClient: {
    fontSize: "0.8rem",
    color: "#cbd5e1",
  },
  allocationHours: {
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "#e2e8f0",
  },
};
