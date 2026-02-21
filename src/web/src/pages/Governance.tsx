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
 * Uses useApi() for token-injected API calls (migrated from prop-passing).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../lib/api-provider";
import type {
  Commitment,
  VipContact,
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
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Governance() {
  const api = useApi();

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
      const result = await api.fetchCommitments();
      if (!mountedRef.current) return;
      setCommitments(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [api]);

  const loadVips = useCallback(async () => {
    try {
      const result = await api.fetchVips();
      if (!mountedRef.current) return;
      setVips(result);
    } catch {
      // Non-critical -- VIP list will be empty
    }
  }, [api]);

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
      await api.addVip({ name: vipName.trim(), email: vipEmail.trim(), notes: vipNotes.trim() });
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
  }, [vipName, vipEmail, vipNotes, api, loadVips, showStatus]);

  const handleRemoveVip = useCallback(
    async (vipId: string) => {
      try {
        await api.removeVip(vipId);
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
    [api, loadVips, showStatus],
  );

  // -------------------------------------------------------------------------
  // Export handler
  // -------------------------------------------------------------------------

  const handleExportProof = useCallback(
    async (commitmentId: string) => {
      setExportingId(commitmentId);
      try {
        const result = await api.exportProof(commitmentId);
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
    [api, showStatus],
  );

  // -------------------------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div data-testid="governance-loading" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Governance Dashboard</h1>
        <p className="text-muted-foreground text-center py-8">Loading governance data...</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Error
  // -------------------------------------------------------------------------

  if (error) {
    return (
      <div data-testid="governance-error" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Governance Dashboard</h1>
        <div className="text-destructive text-center py-8">
          <p>Failed to load commitments: {error}</p>
          <Button
            onClick={async () => {
              setLoading(true);
              setError(null);
              await loadCommitments();
              await loadVips();
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
  // Computed data
  // -------------------------------------------------------------------------

  const chartData = toChartData(commitments);
  const maxHours = chartMaxHours(chartData);
  const timeAllocations = aggregateTimeAllocations(commitments, allocationMode);

  // -------------------------------------------------------------------------
  // Render: Main
  // -------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-foreground">Governance Dashboard</h1>
        <a href="#/calendar" className="text-muted-foreground text-sm no-underline hover:text-foreground">
          Back to Calendar
        </a>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div
          data-testid="governance-status-msg"
          className={`px-4 py-2 rounded-md text-sm font-medium mb-4 border ${
            statusMsg.type === "success"
              ? "bg-emerald-950 text-emerald-300 border-emerald-600"
              : "bg-red-950 text-red-300 border-red-700"
          }`}
        >
          {statusMsg.text}
        </div>
      )}

      {/* ================================================================= */}
      {/* Commitment Compliance Chart                                       */}
      {/* ================================================================= */}
      <Card data-testid="compliance-chart" className="mb-6">
        <CardContent className="p-6">
          <h2 className="text-lg font-bold text-foreground mb-4 mt-0">Commitment Compliance</h2>

          {chartData.length === 0 ? (
            <div data-testid="chart-empty" className="text-muted-foreground text-center py-8">
              No commitments found.
            </div>
          ) : (
            <div data-testid="chart-bars" className="flex flex-col gap-6">
              {chartData.map((point) => (
                <div
                  key={point.client_name}
                  data-testid={`chart-row-${point.client_name}`}
                  className="flex items-center gap-4 flex-wrap"
                >
                  <div className="w-[120px] min-w-[120px] text-sm text-foreground font-medium text-right">
                    {point.client_name}
                  </div>
                  <div className="flex-1 flex flex-col gap-1 min-w-[200px]">
                    {/* Target bar (grey background) */}
                    <div className="flex items-center gap-2 h-5">
                      <div
                        data-testid={`target-bar-${point.client_name}`}
                        className="h-4 rounded-sm min-w-[2px] transition-all duration-300 bg-slate-600"
                        style={{ width: `${barPercent(point.target_hours, maxHours)}%` }}
                      />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        Target: {formatHours(point.target_hours)}
                      </span>
                    </div>
                    {/* Actual bar (compliance-colored) */}
                    <div className="flex items-center gap-2 h-5">
                      <div
                        data-testid={`actual-bar-${point.client_name}`}
                        className="h-4 rounded-sm min-w-[2px] transition-all duration-300"
                        style={{
                          width: `${barPercent(point.actual_hours, maxHours)}%`,
                          backgroundColor: complianceColor(point.compliance_status),
                        }}
                      />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        Actual: {formatHours(point.actual_hours)}
                      </span>
                    </div>
                  </div>
                  {/* Compliance badge */}
                  <div
                    data-testid={`compliance-badge-${point.client_name}`}
                    className="px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap"
                    style={{
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

          {/* Export proof button per commitment */}
          {commitments.length > 0 && (
            <div data-testid="export-section" className="border-t border-border mt-6 pt-2">
              <h3 className="text-base font-semibold text-foreground mt-4 mb-3">Export Proof</h3>
              {commitments.map((c) => (
                <div
                  key={c.commitment_id}
                  data-testid={`export-row-${c.commitment_id}`}
                  className="flex items-center gap-3 py-2 flex-wrap"
                >
                  <span className="text-sm text-foreground min-w-[120px]">{c.client_name}</span>
                  <Button
                    data-testid={`export-btn-${c.commitment_id}`}
                    onClick={() => handleExportProof(c.commitment_id)}
                    disabled={exportingId === c.commitment_id}
                    variant="outline"
                    size="sm"
                    className="border-primary text-primary"
                  >
                    {exportingId === c.commitment_id ? "Exporting..." : "Export Proof"}
                  </Button>
                  {exportLinks[c.commitment_id] && (
                    <a
                      data-testid={`download-link-${c.commitment_id}`}
                      href={exportLinks[c.commitment_id].download_url}
                      className="text-xs text-emerald-400 underline"
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
        </CardContent>
      </Card>

      {/* ================================================================= */}
      {/* VIP Contacts                                                      */}
      {/* ================================================================= */}
      <Card data-testid="vip-section" className="mb-6">
        <CardContent className="p-6">
          <h2 className="text-lg font-bold text-foreground mb-4 mt-0">VIP Contacts</h2>

          {/* VIP Add Form */}
          <div data-testid="vip-form" className="mb-4">
            <div className="flex gap-4 flex-wrap mb-3">
              <div className="flex-1 min-w-[150px]">
                <label htmlFor="vip-name" className="block text-xs text-muted-foreground uppercase tracking-wider mb-1">Name</label>
                <input
                  id="vip-name"
                  data-testid="vip-name-input"
                  type="text"
                  value={vipName}
                  onChange={(e) => setVipName(e.target.value)}
                  placeholder="Contact name"
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                />
              </div>
              <div className="flex-1 min-w-[150px]">
                <label htmlFor="vip-email" className="block text-xs text-muted-foreground uppercase tracking-wider mb-1">Email</label>
                <input
                  id="vip-email"
                  data-testid="vip-email-input"
                  type="email"
                  value={vipEmail}
                  onChange={(e) => setVipEmail(e.target.value)}
                  placeholder="contact@example.com"
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                />
              </div>
              <div className="flex-1 min-w-[150px]">
                <label htmlFor="vip-notes" className="block text-xs text-muted-foreground uppercase tracking-wider mb-1">Notes</label>
                <input
                  id="vip-notes"
                  data-testid="vip-notes-input"
                  type="text"
                  value={vipNotes}
                  onChange={(e) => setVipNotes(e.target.value)}
                  placeholder="Optional notes"
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
                />
              </div>
            </div>
            <Button
              data-testid="add-vip-btn"
              onClick={handleAddVip}
              disabled={addingVip || !vipName.trim() || !vipEmail.trim()}
            >
              {addingVip ? "Adding..." : "Add VIP"}
            </Button>
          </div>

          {/* VIP List */}
          {vips.length === 0 ? (
            <div data-testid="vip-empty" className="text-muted-foreground text-center py-8">
              No VIP contacts yet. Add one above.
            </div>
          ) : (
            <div data-testid="vip-list" className="flex flex-col gap-2">
              {vips.map((vip) => (
                <div
                  key={vip.vip_id}
                  data-testid={`vip-row-${vip.vip_id}`}
                  className="flex justify-between items-center px-4 py-3 bg-background rounded-lg border border-border flex-wrap gap-2"
                >
                  <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <span data-testid={`vip-name-${vip.vip_id}`} className="text-sm text-foreground font-semibold">
                      {vip.name}
                    </span>
                    <span className="text-xs text-muted-foreground">{vip.email}</span>
                    {vip.notes && (
                      <span className="text-xs text-muted-foreground/60 italic">{vip.notes}</span>
                    )}
                  </div>
                  <Button
                    data-testid={`remove-vip-btn-${vip.vip_id}`}
                    onClick={() => handleRemoveVip(vip.vip_id)}
                    variant="outline"
                    size="sm"
                    className="border-destructive text-destructive hover:bg-destructive/10"
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ================================================================= */}
      {/* Time Allocation                                                   */}
      {/* ================================================================= */}
      <Card data-testid="time-allocation-section" className="mb-6">
        <CardContent className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-foreground mt-0">Time Allocation</h2>
            <div className="flex rounded-md overflow-hidden border border-input">
              <button
                data-testid="view-weekly-btn"
                onClick={() => setAllocationMode("weekly")}
                className={`px-3 py-1.5 border-none text-xs font-medium cursor-pointer ${
                  allocationMode === "weekly"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground"
                }`}
              >
                Weekly
              </button>
              <button
                data-testid="view-monthly-btn"
                onClick={() => setAllocationMode("monthly")}
                className={`px-3 py-1.5 border-none text-xs font-medium cursor-pointer ${
                  allocationMode === "monthly"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground"
                }`}
              >
                Monthly
              </button>
            </div>
          </div>

          {timeAllocations.length === 0 ? (
            <div data-testid="allocation-empty" className="text-muted-foreground text-center py-8">
              No time allocation data available.
            </div>
          ) : (
            <div data-testid="allocation-periods">
              {timeAllocations.map((period) => (
                <div
                  key={period.period_label}
                  data-testid={`period-${period.period_label}`}
                  className="bg-background rounded-lg border border-border p-4 mb-3"
                >
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-sm font-semibold text-foreground">{period.period_label}</span>
                    <span
                      data-testid={`period-total-${period.period_label}`}
                      className="text-sm font-bold text-primary"
                    >
                      Total: {formatHours(period.total_hours)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {period.allocations.map((alloc) => (
                      <div
                        key={alloc.client_name}
                        data-testid={`allocation-${period.period_label}-${alloc.client_name}`}
                        className="flex justify-between items-center px-2 py-1 rounded"
                      >
                        <span className="text-xs text-muted-foreground">{alloc.client_name}</span>
                        <span className="text-xs font-semibold text-foreground">
                          {formatHours(alloc.hours)}
                        </span>
                      </div>
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
