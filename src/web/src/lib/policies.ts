/**
 * Policy management types and helpers for the T-Minus SPA.
 *
 * Provides types for the policy matrix (account-to-account projection rules)
 * and API helpers for fetching/updating policy edges.
 *
 * The policy matrix is a directed graph where:
 * - Rows represent "from" accounts (event sources)
 * - Columns represent "to" accounts (projection targets)
 * - Cells represent the detail level (BUSY, TITLE, FULL)
 *
 * Self-edges (from === to) are excluded from the matrix.
 */

import { apiFetch } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Detail level for event projection between accounts. */
export type DetailLevel = "BUSY" | "TITLE" | "FULL";

/** The default detail level for new policy edges. */
export const DEFAULT_DETAIL_LEVEL: DetailLevel = "BUSY";

/** All valid detail levels in display order. */
export const DETAIL_LEVELS: readonly DetailLevel[] = [
  "BUSY",
  "TITLE",
  "FULL",
] as const;

/** A linked account summary for display in the matrix. */
export interface PolicyAccount {
  readonly account_id: string;
  readonly email: string;
}

/** A single policy edge: from one account to another with a detail level. */
export interface PolicyEdgeData {
  readonly policy_id: string;
  readonly from_account_id: string;
  readonly to_account_id: string;
  readonly detail_level: DetailLevel;
}

/** Response shape from GET /api/v1/policies. */
export interface PolicyMatrixData {
  readonly accounts: readonly PolicyAccount[];
  readonly edges: readonly PolicyEdgeData[];
}

interface ApiLinkedAccount {
  readonly account_id: string;
  readonly email: string;
}

interface ApiPolicySummary {
  readonly policy_id: string;
  readonly name?: string;
  readonly is_default?: boolean | number;
}

interface ApiPolicyEdge {
  readonly policy_id?: string;
  readonly from_account_id: string;
  readonly to_account_id: string;
  readonly detail_level: DetailLevel;
  readonly calendar_kind?: "BUSY_OVERLAY" | "TRUE_MIRROR";
}

interface ApiPolicyDetail {
  readonly policy_id: string;
  readonly edges?: readonly ApiPolicyEdge[];
}

/** A cell in the computed matrix grid. */
export interface MatrixCell {
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly policyId: string | null;
  readonly detailLevel: DetailLevel;
  readonly isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Matrix computation
// ---------------------------------------------------------------------------

/**
 * Build a flat array of MatrixCell from accounts and edges.
 *
 * For each (from, to) pair where from !== to, looks up the corresponding
 * edge. If no edge exists, creates a cell with the DEFAULT_DETAIL_LEVEL
 * and isDefault=true.
 */
export function buildMatrixCells(
  accounts: readonly PolicyAccount[],
  edges: readonly PolicyEdgeData[],
): MatrixCell[] {
  // Index edges by "from:to" for O(1) lookup
  const edgeMap = new Map<string, PolicyEdgeData>();
  for (const edge of edges) {
    edgeMap.set(`${edge.from_account_id}:${edge.to_account_id}`, edge);
  }

  const cells: MatrixCell[] = [];

  for (const from of accounts) {
    for (const to of accounts) {
      if (from.account_id === to.account_id) continue;

      const edge = edgeMap.get(`${from.account_id}:${to.account_id}`);
      cells.push({
        fromAccountId: from.account_id,
        toAccountId: to.account_id,
        policyId: edge?.policy_id ?? null,
        detailLevel: edge?.detail_level ?? DEFAULT_DETAIL_LEVEL,
        isDefault: !edge,
      });
    }
  }

  return cells;
}

/**
 * Get the next detail level in the cycle: BUSY -> TITLE -> FULL -> BUSY.
 */
export function nextDetailLevel(current: DetailLevel): DetailLevel {
  const idx = DETAIL_LEVELS.indexOf(current);
  return DETAIL_LEVELS[(idx + 1) % DETAIL_LEVELS.length];
}

/**
 * Look up a specific cell in the matrix by from/to account IDs.
 */
export function findCell(
  cells: readonly MatrixCell[],
  fromAccountId: string,
  toAccountId: string,
): MatrixCell | undefined {
  return cells.find(
    (c) => c.fromAccountId === fromAccountId && c.toAccountId === toAccountId,
  );
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function isPolicyMatrixData(data: unknown): data is PolicyMatrixData {
  if (!data || typeof data !== "object") return false;
  const record = data as { accounts?: unknown; edges?: unknown };
  return Array.isArray(record.accounts) && Array.isArray(record.edges);
}

function isDefaultPolicy(policy: ApiPolicySummary): boolean {
  return policy.is_default === true || policy.is_default === 1;
}

function pickPolicyId(policies: readonly ApiPolicySummary[]): string | null {
  if (policies.length === 0) return null;
  const defaultPolicy = policies.find(isDefaultPolicy);
  return (defaultPolicy ?? policies[0]).policy_id;
}

async function resolvePolicyId(
  token: string,
  policyId: string,
): Promise<string> {
  if (policyId && policyId !== "new") return policyId;
  const policies = await apiFetch<ApiPolicySummary[]>("/v1/policies", { token });
  const resolved = pickPolicyId(policies);
  if (!resolved) {
    throw new Error("No policy found. Link at least two accounts first.");
  }
  return resolved;
}

/** Fetch all policy data (accounts + edges) for the current user. */
export async function fetchPolicies(
  token: string,
): Promise<PolicyMatrixData> {
  // Backward-compatible path: if API already returns the matrix shape, use it directly.
  const policiesResponse = await apiFetch<PolicyMatrixData | ApiPolicySummary[]>(
    "/v1/policies",
    { token },
  );
  if (isPolicyMatrixData(policiesResponse)) {
    return policiesResponse;
  }

  const policyId = pickPolicyId(policiesResponse);
  const [accounts, policyDetail] = await Promise.all([
    apiFetch<ApiLinkedAccount[]>("/v1/accounts", { token }),
    policyId
      ? apiFetch<ApiPolicyDetail>(`/v1/policies/${encodeURIComponent(policyId)}`, {
          token,
        })
      : Promise.resolve<ApiPolicyDetail | null>(null),
  ]);

  const matrixAccounts: PolicyAccount[] = accounts.map((acc) => ({
    account_id: acc.account_id,
    email: acc.email,
  }));
  const matrixEdges: PolicyEdgeData[] = (policyDetail?.edges ?? []).map((edge) => ({
    policy_id: edge.policy_id ?? policyDetail?.policy_id ?? "",
    from_account_id: edge.from_account_id,
    to_account_id: edge.to_account_id,
    detail_level: edge.detail_level,
  }));

  return {
    accounts: matrixAccounts,
    edges: matrixEdges,
  };
}

/** Update a policy edge's detail level. */
export async function updatePolicyEdge(
  token: string,
  policyId: string,
  edge: {
    from_account_id: string;
    to_account_id: string;
    detail_level: DetailLevel;
  },
): Promise<PolicyEdgeData> {
  const resolvedPolicyId = await resolvePolicyId(token, policyId);
  const policy = await apiFetch<ApiPolicyDetail>(
    `/v1/policies/${encodeURIComponent(resolvedPolicyId)}`,
    { token },
  );

  const existingEdges = [...(policy.edges ?? [])];
  const index = existingEdges.findIndex(
    (candidate) =>
      candidate.from_account_id === edge.from_account_id &&
      candidate.to_account_id === edge.to_account_id,
  );

  if (index >= 0) {
    existingEdges[index] = {
      ...existingEdges[index],
      detail_level: edge.detail_level,
    };
  } else {
    existingEdges.push({
      from_account_id: edge.from_account_id,
      to_account_id: edge.to_account_id,
      detail_level: edge.detail_level,
      calendar_kind: "BUSY_OVERLAY",
    });
  }

  await apiFetch<{ edges_set: number; projections_recomputed: number }>(
    `/v1/policies/${encodeURIComponent(resolvedPolicyId)}/edges`,
    {
      method: "PUT",
      body: { edges: existingEdges },
      token,
    },
  );

  return {
    policy_id: resolvedPolicyId,
    from_account_id: edge.from_account_id,
    to_account_id: edge.to_account_id,
    detail_level: edge.detail_level,
  };
}
