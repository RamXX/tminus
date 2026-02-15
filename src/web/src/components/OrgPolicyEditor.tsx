/**
 * OrgPolicyEditor component.
 *
 * Provides a form-based UI for creating, editing, and deleting org-level
 * policies. Admin users see full CRUD controls; members see a read-only
 * list of active policies.
 *
 * Policy types:
 *   - mandatory_working_hours (start_hour, end_hour)
 *   - minimum_vip_priority (min_weight)
 *   - required_projection_detail (detail_level: BUSY|TITLE|FULL)
 *   - max_account_count (max_accounts)
 *
 * Each policy type has a specialized form that validates inputs before
 * submission.
 */

import { useState, useCallback } from "react";
import type { OrgPolicy, OrgPolicyType, CreatePolicyPayload, UpdatePolicyPayload } from "../lib/admin";
import {
  VALID_POLICY_TYPES,
  POLICY_TYPE_LABELS,
  validatePolicyConfig,
  parsePolicyConfig,
} from "../lib/admin";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OrgPolicyEditorProps {
  /** Current list of org policies. */
  policies: OrgPolicy[];
  /** Whether the current user is an admin. */
  isAdmin: boolean;
  /** Create a new policy (admin only). */
  onCreatePolicy: (payload: CreatePolicyPayload) => Promise<void>;
  /** Update an existing policy (admin only). */
  onUpdatePolicy: (policyId: string, payload: UpdatePolicyPayload) => Promise<void>;
  /** Delete a policy (admin only). */
  onDeletePolicy: (policyId: string) => Promise<void>;
  /** Loading state. */
  loading: boolean;
  /** Error message, if any. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrgPolicyEditor({
  policies,
  isAdmin,
  onCreatePolicy,
  onUpdatePolicy,
  onDeletePolicy,
  loading,
  error,
}: OrgPolicyEditorProps) {
  // -- Form state --
  const [formMode, setFormMode] = useState<"idle" | "create" | "edit">("idle");
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<OrgPolicyType>("mandatory_working_hours");
  const [configFields, setConfigFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // -- Determine which policy types are already in use --
  const usedTypes = new Set(policies.map((p) => p.policy_type));
  const availableTypes = VALID_POLICY_TYPES.filter((t) => !usedTypes.has(t));

  // -- Default config fields for a policy type --
  const getDefaultFields = useCallback((type: OrgPolicyType): Record<string, string> => {
    switch (type) {
      case "mandatory_working_hours":
        return { start_hour: "9", end_hour: "17" };
      case "minimum_vip_priority":
        return { min_weight: "50" };
      case "required_projection_detail":
        return { detail_level: "BUSY" };
      case "max_account_count":
        return { max_accounts: "5" };
      default:
        return {};
    }
  }, []);

  // -- Open create form --
  const openCreateForm = useCallback(() => {
    const firstAvailable = availableTypes[0] || "mandatory_working_hours";
    setFormMode("create");
    setEditingPolicyId(null);
    setSelectedType(firstAvailable);
    setConfigFields(getDefaultFields(firstAvailable));
    setFormError(null);
  }, [availableTypes, getDefaultFields]);

  // -- Open edit form for an existing policy --
  const openEditForm = useCallback(
    (policy: OrgPolicy) => {
      setFormMode("edit");
      setEditingPolicyId(policy.policy_id);
      setSelectedType(policy.policy_type);
      const parsed = parsePolicyConfig(policy.config_json);
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        fields[k] = String(v);
      }
      setConfigFields(fields);
      setFormError(null);
    },
    [],
  );

  // -- Close form --
  const closeForm = useCallback(() => {
    setFormMode("idle");
    setEditingPolicyId(null);
    setFormError(null);
    setConfigFields({});
  }, []);

  // -- Build typed config from string fields --
  const buildConfig = useCallback(
    (type: OrgPolicyType, fields: Record<string, string>): Record<string, unknown> => {
      switch (type) {
        case "mandatory_working_hours":
          return {
            start_hour: Number(fields.start_hour || "0"),
            end_hour: Number(fields.end_hour || "0"),
          };
        case "minimum_vip_priority":
          return { min_weight: Number(fields.min_weight || "0") };
        case "required_projection_detail":
          return { detail_level: fields.detail_level || "BUSY" };
        case "max_account_count":
          return { max_accounts: Number(fields.max_accounts || "0") };
        default:
          return {};
      }
    },
    [],
  );

  // -- Submit handler --
  const handleSubmit = useCallback(async () => {
    const config = buildConfig(selectedType, configFields);
    const validationError = validatePolicyConfig(selectedType, config);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setActionError(null);

    try {
      if (formMode === "create") {
        await onCreatePolicy({ policy_type: selectedType, config });
      } else if (formMode === "edit" && editingPolicyId) {
        await onUpdatePolicy(editingPolicyId, { config });
      }
      closeForm();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setSubmitting(false);
    }
  }, [
    selectedType,
    configFields,
    formMode,
    editingPolicyId,
    buildConfig,
    onCreatePolicy,
    onUpdatePolicy,
    closeForm,
  ]);

  // -- Delete handler --
  const handleDelete = useCallback(
    async (policyId: string) => {
      setActionError(null);
      try {
        await onDeletePolicy(policyId);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to delete policy");
      }
    },
    [onDeletePolicy],
  );

  // -- Render helpers --

  const renderConfigForm = () => {
    switch (selectedType) {
      case "mandatory_working_hours":
        return (
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label htmlFor="start-hour" style={styles.label}>
                Start Hour (0-23)
              </label>
              <input
                id="start-hour"
                data-testid="config-start-hour"
                type="number"
                min={0}
                max={23}
                value={configFields.start_hour || ""}
                onChange={(e) =>
                  setConfigFields((f) => ({ ...f, start_hour: e.target.value }))
                }
                style={styles.input}
              />
            </div>
            <div style={styles.formGroup}>
              <label htmlFor="end-hour" style={styles.label}>
                End Hour (0-23)
              </label>
              <input
                id="end-hour"
                data-testid="config-end-hour"
                type="number"
                min={0}
                max={23}
                value={configFields.end_hour || ""}
                onChange={(e) =>
                  setConfigFields((f) => ({ ...f, end_hour: e.target.value }))
                }
                style={styles.input}
              />
            </div>
          </div>
        );
      case "minimum_vip_priority":
        return (
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label htmlFor="min-weight" style={styles.label}>
                Minimum Weight (0-100)
              </label>
              <input
                id="min-weight"
                data-testid="config-min-weight"
                type="number"
                min={0}
                max={100}
                value={configFields.min_weight || ""}
                onChange={(e) =>
                  setConfigFields((f) => ({ ...f, min_weight: e.target.value }))
                }
                style={styles.input}
              />
            </div>
          </div>
        );
      case "required_projection_detail":
        return (
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label htmlFor="detail-level" style={styles.label}>
                Detail Level
              </label>
              <select
                id="detail-level"
                data-testid="config-detail-level"
                value={configFields.detail_level || "BUSY"}
                onChange={(e) =>
                  setConfigFields((f) => ({ ...f, detail_level: e.target.value }))
                }
                style={styles.input}
              >
                <option value="BUSY">BUSY</option>
                <option value="TITLE">TITLE</option>
                <option value="FULL">FULL</option>
              </select>
            </div>
          </div>
        );
      case "max_account_count":
        return (
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label htmlFor="max-accounts" style={styles.label}>
                Max Accounts
              </label>
              <input
                id="max-accounts"
                data-testid="config-max-accounts"
                type="number"
                min={1}
                value={configFields.max_accounts || ""}
                onChange={(e) =>
                  setConfigFields((f) => ({ ...f, max_accounts: e.target.value }))
                }
                style={styles.input}
              />
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  // -- Main render --

  if (loading) {
    return (
      <div data-testid="policy-editor-loading" style={styles.card}>
        <h2 style={styles.sectionTitle}>Organization Policies</h2>
        <div style={styles.loading}>Loading policies...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="policy-editor-error" style={styles.card}>
        <h2 style={styles.sectionTitle}>Organization Policies</h2>
        <div style={styles.errorBox}>Failed to load policies: {error}</div>
      </div>
    );
  }

  return (
    <div data-testid="policy-editor" style={styles.card}>
      <div style={styles.headerRow}>
        <h2 style={styles.sectionTitle}>Organization Policies</h2>
        {isAdmin && formMode === "idle" && availableTypes.length > 0 && (
          <button
            data-testid="create-policy-btn"
            onClick={openCreateForm}
            style={styles.addBtn}
          >
            Create Policy
          </button>
        )}
      </div>

      {actionError && (
        <div data-testid="policy-action-error" style={styles.actionError}>
          {actionError}
        </div>
      )}

      {/* Create/Edit form */}
      {isAdmin && formMode !== "idle" && (
        <div data-testid="policy-form" style={styles.policyForm}>
          <h3 style={styles.formTitle}>
            {formMode === "create" ? "Create Policy" : "Edit Policy"}
          </h3>

          {formMode === "create" && (
            <div style={styles.formRow}>
              <div style={styles.formGroup}>
                <label htmlFor="policy-type-select" style={styles.label}>
                  Policy Type
                </label>
                <select
                  id="policy-type-select"
                  data-testid="policy-type-select"
                  value={selectedType}
                  onChange={(e) => {
                    const type = e.target.value as OrgPolicyType;
                    setSelectedType(type);
                    setConfigFields(getDefaultFields(type));
                    setFormError(null);
                  }}
                  style={styles.input}
                >
                  {availableTypes.map((t) => (
                    <option key={t} value={t}>
                      {POLICY_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {formMode === "edit" && (
            <div style={styles.editTypeLabel}>
              Type: {POLICY_TYPE_LABELS[selectedType]}
            </div>
          )}

          {renderConfigForm()}

          {formError && (
            <div data-testid="policy-form-error" style={styles.formError}>
              {formError}
            </div>
          )}

          <div style={styles.formActions}>
            <button
              data-testid="policy-submit-btn"
              onClick={handleSubmit}
              disabled={submitting}
              style={{
                ...styles.submitBtn,
                opacity: submitting ? 0.5 : 1,
              }}
            >
              {submitting
                ? "Saving..."
                : formMode === "create"
                  ? "Create Policy"
                  : "Update Policy"}
            </button>
            <button
              data-testid="policy-cancel-btn"
              onClick={closeForm}
              style={styles.cancelBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Policy list */}
      {policies.length === 0 ? (
        <div data-testid="policy-list-empty" style={styles.emptyState}>
          No organization policies configured.
        </div>
      ) : (
        <div data-testid="policy-rows">
          {policies.map((p) => {
            const config = parsePolicyConfig(p.config_json);
            return (
              <div
                key={p.policy_id}
                data-testid={`policy-row-${p.policy_id}`}
                style={styles.policyRow}
              >
                <div style={styles.policyInfo}>
                  <span
                    data-testid={`policy-type-${p.policy_id}`}
                    style={styles.policyType}
                  >
                    {POLICY_TYPE_LABELS[p.policy_type] || p.policy_type}
                  </span>
                  <span
                    data-testid={`policy-config-${p.policy_id}`}
                    style={styles.policyConfig}
                  >
                    {Object.entries(config)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(", ")}
                  </span>
                </div>

                {isAdmin && (
                  <div style={styles.policyActions}>
                    <button
                      data-testid={`edit-policy-btn-${p.policy_id}`}
                      onClick={() => openEditForm(p)}
                      style={styles.editBtn}
                    >
                      Edit
                    </button>
                    <button
                      data-testid={`delete-policy-btn-${p.policy_id}`}
                      onClick={() => handleDelete(p.policy_id)}
                      style={styles.removeBtn}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  card: {
    backgroundColor: "#1e293b",
    borderRadius: "12px",
    padding: "1.5rem",
    border: "1px solid #334155",
    marginBottom: "2rem",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1rem",
  },
  sectionTitle: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "#f1f5f9",
    marginTop: 0,
    marginBottom: 0,
  },
  loading: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
  errorBox: {
    color: "#fca5a5",
    padding: "1rem",
    textAlign: "center" as const,
  },
  actionError: {
    color: "#fca5a5",
    backgroundColor: "#450a0a",
    border: "1px solid #dc2626",
    borderRadius: "6px",
    padding: "0.5rem 1rem",
    marginBottom: "1rem",
    fontSize: "0.875rem",
  },
  emptyState: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
  policyForm: {
    backgroundColor: "#0f172a",
    borderRadius: "8px",
    border: "1px solid #475569",
    padding: "1.25rem",
    marginBottom: "1.5rem",
  },
  formTitle: {
    fontSize: "0.95rem",
    fontWeight: 600,
    color: "#e2e8f0",
    marginTop: 0,
    marginBottom: "1rem",
  },
  editTypeLabel: {
    fontSize: "0.875rem",
    color: "#94a3b8",
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
  formError: {
    color: "#fca5a5",
    fontSize: "0.8rem",
    marginBottom: "0.75rem",
  },
  formActions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "0.5rem",
  },
  submitBtn: {
    padding: "0.5rem 1.25rem",
    borderRadius: "6px",
    border: "none",
    backgroundColor: "#3b82f6",
    color: "#ffffff",
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  cancelBtn: {
    padding: "0.5rem 1.25rem",
    borderRadius: "6px",
    border: "1px solid #475569",
    backgroundColor: "transparent",
    color: "#94a3b8",
    fontSize: "0.875rem",
    cursor: "pointer",
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
  policyRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.75rem 1rem",
    backgroundColor: "#0f172a",
    borderRadius: "8px",
    border: "1px solid #334155",
    marginBottom: "0.5rem",
    flexWrap: "wrap" as const,
    gap: "0.5rem",
  },
  policyInfo: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.25rem",
    flex: 1,
    minWidth: 0,
  },
  policyType: {
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 600,
  },
  policyConfig: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  policyActions: {
    display: "flex",
    gap: "0.5rem",
  },
  editBtn: {
    padding: "0.35rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #3b82f6",
    background: "transparent",
    color: "#3b82f6",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontWeight: 500,
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
};
