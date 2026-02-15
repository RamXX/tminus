/**
 * Admin Console page.
 *
 * Route: #/admin/:orgId
 *
 * Composes OrgMemberList, OrgPolicyEditor, and OrgUsageDashboard into
 * a unified admin console for enterprise org management.
 *
 * RBAC behavior:
 * - Admin: sees all management controls (add/remove members, CRUD policies)
 * - Member: sees read-only views of members, policies, and usage
 * - Non-member: sees access denied message
 *
 * Enterprise tier enforcement:
 * - Non-enterprise users see an upgrade prompt instead of the admin console
 *
 * Props follow the dependency injection pattern for testability.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  OrgDetails,
  OrgMember,
  OrgPolicy,
  MemberUsage,
  OrgRole,
  CreatePolicyPayload,
  UpdatePolicyPayload,
} from "../lib/admin";
import { OrgMemberList } from "../components/OrgMemberList";
import { OrgPolicyEditor } from "../components/OrgPolicyEditor";
import { OrgUsageDashboard } from "../components/OrgUsageDashboard";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AdminProps {
  /** The org ID from the URL. */
  orgId: string;
  /** Current user's ID (from auth context). */
  currentUserId: string;
  /** Current user's billing tier. */
  userTier: string;
  /** Fetch org details. */
  fetchOrgDetails: (orgId: string) => Promise<OrgDetails>;
  /** Fetch org members. */
  fetchOrgMembers: (orgId: string) => Promise<OrgMember[]>;
  /** Add a member. */
  addOrgMember: (orgId: string, userId: string, role: OrgRole) => Promise<void>;
  /** Remove a member. */
  removeOrgMember: (orgId: string, userId: string) => Promise<void>;
  /** Change a member's role. */
  changeOrgMemberRole: (orgId: string, userId: string, role: OrgRole) => Promise<void>;
  /** Fetch org policies. */
  fetchOrgPolicies: (orgId: string) => Promise<OrgPolicy[]>;
  /** Create a policy. */
  createOrgPolicy: (orgId: string, payload: CreatePolicyPayload) => Promise<void>;
  /** Update a policy. */
  updateOrgPolicy: (orgId: string, policyId: string, payload: UpdatePolicyPayload) => Promise<void>;
  /** Delete a policy. */
  deleteOrgPolicy: (orgId: string, policyId: string) => Promise<void>;
  /** Fetch org usage stats. */
  fetchOrgUsage: (orgId: string) => Promise<MemberUsage[]>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Admin({
  orgId,
  currentUserId,
  userTier,
  fetchOrgDetails,
  fetchOrgMembers,
  addOrgMember,
  removeOrgMember,
  changeOrgMemberRole,
  fetchOrgPolicies,
  createOrgPolicy,
  updateOrgPolicy,
  deleteOrgPolicy,
  fetchOrgUsage,
}: AdminProps) {
  // -- State --
  const [orgDetails, setOrgDetails] = useState<OrgDetails | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [policies, setPolicies] = useState<OrgPolicy[]>([]);
  const [usage, setUsage] = useState<MemberUsage[]>([]);

  const [loadingOrg, setLoadingOrg] = useState(true);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [loadingPolicies, setLoadingPolicies] = useState(true);
  const [loadingUsage, setLoadingUsage] = useState(true);

  const [orgError, setOrgError] = useState<string | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [policiesError, setPoliciesError] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  // -- Determine user's role in this org --
  const currentMember = members.find((m) => m.user_id === currentUserId);
  const isAdmin = currentMember?.role === "admin";
  const isMember = !!currentMember;

  // -- Enterprise tier check --
  const isEnterprise = userTier === "enterprise";

  // -- Data loaders --

  const loadOrgDetails = useCallback(async () => {
    try {
      setLoadingOrg(true);
      const details = await fetchOrgDetails(orgId);
      if (!mountedRef.current) return;
      setOrgDetails(details);
      setOrgError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setOrgError(err instanceof Error ? err.message : "Failed to load org");
    } finally {
      if (mountedRef.current) setLoadingOrg(false);
    }
  }, [orgId, fetchOrgDetails]);

  const loadMembers = useCallback(async () => {
    try {
      setLoadingMembers(true);
      const result = await fetchOrgMembers(orgId);
      if (!mountedRef.current) return;
      setMembers(result);
      setMembersError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setMembersError(err instanceof Error ? err.message : "Failed to load members");
    } finally {
      if (mountedRef.current) setLoadingMembers(false);
    }
  }, [orgId, fetchOrgMembers]);

  const loadPolicies = useCallback(async () => {
    try {
      setLoadingPolicies(true);
      const result = await fetchOrgPolicies(orgId);
      if (!mountedRef.current) return;
      setPolicies(result);
      setPoliciesError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setPoliciesError(err instanceof Error ? err.message : "Failed to load policies");
    } finally {
      if (mountedRef.current) setLoadingPolicies(false);
    }
  }, [orgId, fetchOrgPolicies]);

  const loadUsage = useCallback(async () => {
    try {
      setLoadingUsage(true);
      const result = await fetchOrgUsage(orgId);
      if (!mountedRef.current) return;
      setUsage(result);
      setUsageError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setUsageError(err instanceof Error ? err.message : "Failed to load usage");
    } finally {
      if (mountedRef.current) setLoadingUsage(false);
    }
  }, [orgId, fetchOrgUsage]);

  // -- Initial load --
  useEffect(() => {
    mountedRef.current = true;
    loadOrgDetails();
    loadMembers();
    loadPolicies();
    loadUsage();
    return () => {
      mountedRef.current = false;
    };
  }, [loadOrgDetails, loadMembers, loadPolicies, loadUsage]);

  // -- Action handlers (delegate to props, then reload) --

  const handleAddMember = useCallback(
    async (userId: string, role: OrgRole) => {
      await addOrgMember(orgId, userId, role);
      await loadMembers();
      await loadUsage();
    },
    [orgId, addOrgMember, loadMembers, loadUsage],
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      await removeOrgMember(orgId, userId);
      await loadMembers();
      await loadUsage();
    },
    [orgId, removeOrgMember, loadMembers, loadUsage],
  );

  const handleChangeRole = useCallback(
    async (userId: string, role: OrgRole) => {
      await changeOrgMemberRole(orgId, userId, role);
      await loadMembers();
    },
    [orgId, changeOrgMemberRole, loadMembers],
  );

  const handleCreatePolicy = useCallback(
    async (payload: CreatePolicyPayload) => {
      await createOrgPolicy(orgId, payload);
      await loadPolicies();
    },
    [orgId, createOrgPolicy, loadPolicies],
  );

  const handleUpdatePolicy = useCallback(
    async (policyId: string, payload: UpdatePolicyPayload) => {
      await updateOrgPolicy(orgId, policyId, payload);
      await loadPolicies();
    },
    [orgId, updateOrgPolicy, loadPolicies],
  );

  const handleDeletePolicy = useCallback(
    async (policyId: string) => {
      await deleteOrgPolicy(orgId, policyId);
      await loadPolicies();
    },
    [orgId, deleteOrgPolicy, loadPolicies],
  );

  // -- Non-enterprise gate --
  if (!isEnterprise) {
    return (
      <div data-testid="admin-upgrade-prompt" style={styles.container}>
        <h1 style={styles.title}>Admin Console</h1>
        <div style={styles.upgradeCard}>
          <h2 style={styles.upgradeTitle}>Enterprise Tier Required</h2>
          <p style={styles.upgradeText}>
            The admin console is available on the Enterprise plan. Upgrade your
            subscription to manage organizations, members, and policies.
          </p>
          <a href="#/billing" style={styles.upgradeLink}>
            Upgrade Plan
          </a>
        </div>
      </div>
    );
  }

  // -- Org loading --
  if (loadingOrg) {
    return (
      <div data-testid="admin-loading" style={styles.container}>
        <h1 style={styles.title}>Admin Console</h1>
        <div style={styles.loading}>Loading organization...</div>
      </div>
    );
  }

  // -- Org error --
  if (orgError) {
    return (
      <div data-testid="admin-error" style={styles.container}>
        <h1 style={styles.title}>Admin Console</h1>
        <div style={styles.errorBox}>
          <p>Failed to load organization: {orgError}</p>
          <button onClick={loadOrgDetails} style={styles.retryBtn}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // -- Members failed to load (cannot verify membership) --
  if (!loadingMembers && membersError) {
    return (
      <div data-testid="admin-members-error" style={styles.container}>
        <h1 style={styles.title}>Admin Console</h1>
        <div style={styles.errorBox}>
          <p>Failed to load members: {membersError}</p>
          <button onClick={loadMembers} style={styles.retryBtn}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // -- Access denied (not a member) --
  if (!loadingMembers && !isMember) {
    return (
      <div data-testid="admin-access-denied" style={styles.container}>
        <h1 style={styles.title}>Admin Console</h1>
        <div style={styles.errorBox}>
          You are not a member of this organization.
        </div>
      </div>
    );
  }

  // -- Main render --
  return (
    <div data-testid="admin-console" style={styles.container}>
      <div style={styles.headerRow}>
        <div>
          <h1 style={styles.title}>Admin Console</h1>
          {orgDetails && (
            <span data-testid="org-name" style={styles.orgName}>
              {orgDetails.name}
            </span>
          )}
        </div>
        <div style={styles.headerLinks}>
          {isAdmin && (
            <span data-testid="admin-badge" style={styles.adminBadge}>
              ADMIN
            </span>
          )}
          <a href="#/calendar" style={styles.backLink}>
            Back to Calendar
          </a>
        </div>
      </div>

      {/* Member List */}
      <OrgMemberList
        members={members}
        isAdmin={isAdmin}
        onAddMember={handleAddMember}
        onRemoveMember={handleRemoveMember}
        onChangeRole={handleChangeRole}
        loading={loadingMembers}
        error={membersError}
      />

      {/* Policy Editor */}
      <OrgPolicyEditor
        policies={policies}
        isAdmin={isAdmin}
        onCreatePolicy={handleCreatePolicy}
        onUpdatePolicy={handleUpdatePolicy}
        onDeletePolicy={handleDeletePolicy}
        loading={loadingPolicies}
        error={policiesError}
      />

      {/* Usage Dashboard */}
      <OrgUsageDashboard
        usage={usage}
        loading={loadingUsage}
        error={usageError}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "1200px",
    margin: "0 auto",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: "1.5rem",
    flexWrap: "wrap" as const,
    gap: "0.5rem",
  },
  title: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#f1f5f9",
    margin: 0,
  },
  orgName: {
    fontSize: "0.9rem",
    color: "#94a3b8",
    marginTop: "0.25rem",
    display: "block",
  },
  headerLinks: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  adminBadge: {
    padding: "0.2rem 0.6rem",
    borderRadius: "4px",
    fontSize: "0.7rem",
    fontWeight: 700,
    backgroundColor: "#1e3a5f",
    color: "#60a5fa",
    letterSpacing: "0.05em",
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
  upgradeCard: {
    backgroundColor: "#1e293b",
    borderRadius: "12px",
    padding: "2rem",
    border: "1px solid #334155",
    textAlign: "center" as const,
    marginTop: "2rem",
  },
  upgradeTitle: {
    fontSize: "1.25rem",
    fontWeight: 700,
    color: "#f1f5f9",
    marginTop: 0,
    marginBottom: "1rem",
  },
  upgradeText: {
    color: "#94a3b8",
    fontSize: "0.9rem",
    marginBottom: "1.5rem",
    lineHeight: 1.6,
  },
  upgradeLink: {
    display: "inline-block",
    padding: "0.6rem 1.5rem",
    borderRadius: "6px",
    backgroundColor: "#3b82f6",
    color: "#ffffff",
    fontSize: "0.9rem",
    fontWeight: 600,
    textDecoration: "none",
  },
};
