/**
 * OrgMemberList component.
 *
 * Displays organization members with their roles. Admin users see
 * add/remove member controls; regular members see a read-only list.
 *
 * Props follow the dependency injection pattern used throughout the app:
 * action functions are passed in so the component is easily testable
 * with mock functions.
 */

import { useState, useCallback } from "react";
import type { OrgMember, OrgRole } from "../lib/admin";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OrgMemberListProps {
  /** Current list of org members. */
  members: OrgMember[];
  /** Whether the current user is an admin of this org. */
  isAdmin: boolean;
  /** Add a member (admin only). */
  onAddMember: (userId: string, role: OrgRole) => Promise<void>;
  /** Remove a member (admin only). */
  onRemoveMember: (userId: string) => Promise<void>;
  /** Change a member's role (admin only). */
  onChangeRole: (userId: string, role: OrgRole) => Promise<void>;
  /** Loading state. */
  loading: boolean;
  /** Error message, if any. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrgMemberList({
  members,
  isAdmin,
  onAddMember,
  onRemoveMember,
  onChangeRole,
  loading,
  error,
}: OrgMemberListProps) {
  // -- Add member form state (admin only) --
  const [newUserId, setNewUserId] = useState("");
  const [newRole, setNewRole] = useState<OrgRole>("member");
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleAdd = useCallback(async () => {
    if (!newUserId.trim()) return;
    setAdding(true);
    setActionError(null);
    try {
      await onAddMember(newUserId.trim(), newRole);
      setNewUserId("");
      setNewRole("member");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add member");
    } finally {
      setAdding(false);
    }
  }, [newUserId, newRole, onAddMember]);

  const handleRemove = useCallback(
    async (userId: string) => {
      setActionError(null);
      try {
        await onRemoveMember(userId);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to remove member");
      }
    },
    [onRemoveMember],
  );

  const handleRoleChange = useCallback(
    async (userId: string, role: OrgRole) => {
      setActionError(null);
      try {
        await onChangeRole(userId, role);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to change role");
      }
    },
    [onChangeRole],
  );

  // -- Render --

  if (loading) {
    return (
      <div data-testid="member-list-loading" style={styles.card}>
        <h2 style={styles.sectionTitle}>Organization Members</h2>
        <div style={styles.loading}>Loading members...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="member-list-error" style={styles.card}>
        <h2 style={styles.sectionTitle}>Organization Members</h2>
        <div style={styles.errorBox}>Failed to load members: {error}</div>
      </div>
    );
  }

  return (
    <div data-testid="member-list" style={styles.card}>
      <h2 style={styles.sectionTitle}>Organization Members</h2>

      {actionError && (
        <div data-testid="member-action-error" style={styles.actionError}>
          {actionError}
        </div>
      )}

      {/* Admin: Add member form */}
      {isAdmin && (
        <div data-testid="add-member-form" style={styles.addForm}>
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label htmlFor="new-member-id" style={styles.label}>
                User ID
              </label>
              <input
                id="new-member-id"
                data-testid="new-member-id-input"
                type="text"
                value={newUserId}
                onChange={(e) => setNewUserId(e.target.value)}
                placeholder="user_abc123"
                style={styles.input}
              />
            </div>
            <div style={styles.formGroup}>
              <label htmlFor="new-member-role" style={styles.label}>
                Role
              </label>
              <select
                id="new-member-role"
                data-testid="new-member-role-select"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as OrgRole)}
                style={styles.input}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          <button
            data-testid="add-member-btn"
            onClick={handleAdd}
            disabled={adding || !newUserId.trim()}
            style={{
              ...styles.addBtn,
              opacity: adding || !newUserId.trim() ? 0.5 : 1,
              cursor: adding || !newUserId.trim() ? "not-allowed" : "pointer",
            }}
          >
            {adding ? "Adding..." : "Add Member"}
          </button>
        </div>
      )}

      {/* Member list */}
      {members.length === 0 ? (
        <div data-testid="member-list-empty" style={styles.emptyState}>
          No members found.
        </div>
      ) : (
        <div data-testid="member-rows">
          {members.map((m) => (
            <div
              key={m.user_id}
              data-testid={`member-row-${m.user_id}`}
              style={styles.memberRow}
            >
              <div style={styles.memberInfo}>
                <span data-testid={`member-email-${m.user_id}`} style={styles.memberEmail}>
                  {m.email}
                </span>
                <span
                  data-testid={`member-role-${m.user_id}`}
                  style={{
                    ...styles.roleBadge,
                    backgroundColor: m.role === "admin" ? "#1e3a5f" : "#1e293b",
                    color: m.role === "admin" ? "#60a5fa" : "#94a3b8",
                  }}
                >
                  {m.role}
                </span>
              </div>

              {/* Admin controls */}
              {isAdmin && (
                <div style={styles.memberActions}>
                  <button
                    data-testid={`change-role-btn-${m.user_id}`}
                    onClick={() =>
                      handleRoleChange(
                        m.user_id,
                        m.role === "admin" ? "member" : "admin",
                      )
                    }
                    style={styles.actionBtn}
                  >
                    {m.role === "admin" ? "Demote" : "Promote"}
                  </button>
                  <button
                    data-testid={`remove-member-btn-${m.user_id}`}
                    onClick={() => handleRemove(m.user_id)}
                    style={styles.removeBtn}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles (matches existing component patterns)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
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
  addForm: {
    marginBottom: "1.5rem",
    paddingBottom: "1.5rem",
    borderBottom: "1px solid #334155",
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
  memberRow: {
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
  memberInfo: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    flex: 1,
    minWidth: 0,
  },
  memberEmail: {
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 500,
  },
  roleBadge: {
    padding: "0.15rem 0.5rem",
    borderRadius: "4px",
    fontSize: "0.75rem",
    fontWeight: 600,
    textTransform: "uppercase" as const,
  },
  memberActions: {
    display: "flex",
    gap: "0.5rem",
  },
  actionBtn: {
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
