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
 * Uses useApi() for token-injected API calls (migrated from prop-passing).
 * Uses useParams() for orgId extraction and useAdminTierGate() for tier.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Navigate } from "react-router-dom";
import { useApi } from "../lib/api-provider";
import { useAuth } from "../lib/auth";
import { useAdminTierGate } from "../lib/route-helpers";
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
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Admin() {
  const api = useApi();
  const { user } = useAuth();
  const { orgId } = useParams<{ orgId: string }>();
  const userTier = useAdminTierGate(api.fetchBillingStatus);

  // Redirect if missing orgId or user
  if (!orgId || !user) return <Navigate to="/calendar" replace />;

  return <AdminInner orgId={orgId} currentUserId={user.id} userTier={userTier} />;
}

// ---------------------------------------------------------------------------
// Inner component (after guards)
// ---------------------------------------------------------------------------

function AdminInner({
  orgId,
  currentUserId,
  userTier,
}: {
  orgId: string;
  currentUserId: string;
  userTier: string;
}) {
  const api = useApi();

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
      const details = await api.fetchOrgDetails(orgId);
      if (!mountedRef.current) return;
      setOrgDetails(details);
      setOrgError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setOrgError(err instanceof Error ? err.message : "Failed to load org");
    } finally {
      if (mountedRef.current) setLoadingOrg(false);
    }
  }, [orgId, api]);

  const loadMembers = useCallback(async () => {
    try {
      setLoadingMembers(true);
      const result = await api.fetchOrgMembers(orgId);
      if (!mountedRef.current) return;
      setMembers(result);
      setMembersError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setMembersError(err instanceof Error ? err.message : "Failed to load members");
    } finally {
      if (mountedRef.current) setLoadingMembers(false);
    }
  }, [orgId, api]);

  const loadPolicies = useCallback(async () => {
    try {
      setLoadingPolicies(true);
      const result = await api.fetchOrgPolicies(orgId);
      if (!mountedRef.current) return;
      setPolicies(result);
      setPoliciesError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setPoliciesError(err instanceof Error ? err.message : "Failed to load policies");
    } finally {
      if (mountedRef.current) setLoadingPolicies(false);
    }
  }, [orgId, api]);

  const loadUsage = useCallback(async () => {
    try {
      setLoadingUsage(true);
      const result = await api.fetchOrgUsage(orgId);
      if (!mountedRef.current) return;
      setUsage(result);
      setUsageError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setUsageError(err instanceof Error ? err.message : "Failed to load usage");
    } finally {
      if (mountedRef.current) setLoadingUsage(false);
    }
  }, [orgId, api]);

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

  // -- Action handlers (delegate to api, then reload) --

  const handleAddMember = useCallback(
    async (userId: string, role: OrgRole) => {
      await api.addOrgMember(orgId, userId, role);
      await loadMembers();
      await loadUsage();
    },
    [orgId, api, loadMembers, loadUsage],
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      await api.removeOrgMember(orgId, userId);
      await loadMembers();
      await loadUsage();
    },
    [orgId, api, loadMembers, loadUsage],
  );

  const handleChangeRole = useCallback(
    async (userId: string, role: OrgRole) => {
      await api.changeOrgMemberRole(orgId, userId, role);
      await loadMembers();
    },
    [orgId, api, loadMembers],
  );

  const handleCreatePolicy = useCallback(
    async (payload: CreatePolicyPayload) => {
      await api.createOrgPolicy(orgId, payload);
      await loadPolicies();
    },
    [orgId, api, loadPolicies],
  );

  const handleUpdatePolicy = useCallback(
    async (policyId: string, payload: UpdatePolicyPayload) => {
      await api.updateOrgPolicy(orgId, policyId, payload);
      await loadPolicies();
    },
    [orgId, api, loadPolicies],
  );

  const handleDeletePolicy = useCallback(
    async (policyId: string) => {
      await api.deleteOrgPolicy(orgId, policyId);
      await loadPolicies();
    },
    [orgId, api, loadPolicies],
  );

  // -- Non-enterprise gate --
  if (!isEnterprise) {
    return (
      <div data-testid="admin-upgrade-prompt" className="mx-auto max-w-5xl">
        <h1 className="text-2xl font-bold text-slate-100 m-0">Admin Console</h1>
        <Card className="mt-8 text-center">
          <CardContent className="pt-6">
            <h2 className="text-xl font-bold text-slate-100 mt-0 mb-4">Enterprise Tier Required</h2>
            <p className="text-slate-400 text-sm mb-6 leading-relaxed">
              The admin console is available on the Enterprise plan. Upgrade your
              subscription to manage organizations, members, and policies.
            </p>
            <Button asChild>
              <a href="#/billing">Upgrade Plan</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // -- Org loading --
  if (loadingOrg) {
    return (
      <div data-testid="admin-loading" className="mx-auto max-w-5xl">
        <h1 className="text-2xl font-bold text-slate-100 m-0">Admin Console</h1>
        <div className="text-slate-400 p-8 text-center">Loading organization...</div>
      </div>
    );
  }

  // -- Org error --
  if (orgError) {
    return (
      <div data-testid="admin-error" className="mx-auto max-w-5xl">
        <h1 className="text-2xl font-bold text-slate-100 m-0">Admin Console</h1>
        <div className="text-red-300 p-8 text-center">
          <p>Failed to load organization: {orgError}</p>
          <Button variant="outline" onClick={loadOrgDetails} className="mt-2 border-red-500 text-red-500 hover:bg-red-500/10">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // -- Members failed to load (cannot verify membership) --
  if (!loadingMembers && membersError) {
    return (
      <div data-testid="admin-members-error" className="mx-auto max-w-5xl">
        <h1 className="text-2xl font-bold text-slate-100 m-0">Admin Console</h1>
        <div className="text-red-300 p-8 text-center">
          <p>Failed to load members: {membersError}</p>
          <Button variant="outline" onClick={loadMembers} className="mt-2 border-red-500 text-red-500 hover:bg-red-500/10">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // -- Access denied (not a member) --
  if (!loadingMembers && !isMember) {
    return (
      <div data-testid="admin-access-denied" className="mx-auto max-w-5xl">
        <h1 className="text-2xl font-bold text-slate-100 m-0">Admin Console</h1>
        <div className="text-red-300 p-8 text-center">
          You are not a member of this organization.
        </div>
      </div>
    );
  }

  // -- Main render --
  return (
    <div data-testid="admin-console" className="mx-auto max-w-5xl">
      <div className="flex justify-between items-start mb-6 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 m-0">Admin Console</h1>
          {orgDetails && (
            <span data-testid="org-name" className="text-sm text-slate-400 mt-1 block">
              {orgDetails.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <Badge data-testid="admin-badge" variant="secondary" className="bg-blue-900/50 text-blue-400 text-xs font-bold tracking-wide">
              ADMIN
            </Badge>
          )}
          <a href="#/calendar" className="text-slate-400 text-sm no-underline hover:text-slate-300">
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
