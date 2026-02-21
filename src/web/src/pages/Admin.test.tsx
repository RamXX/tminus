/**
 * Tests for the Admin Console page.
 *
 * Covers all 6 acceptance criteria:
 * AC1: Admin can view and manage org members
 * AC2: Admin can create/edit/delete org policies via form UI
 * AC3: Usage dashboard shows per-member stats
 * AC4: Members see read-only view (no management controls)
 * AC5: Enterprise tier enforced (non-enterprise users see upgrade prompt)
 * AC6: Accessible at /admin/:orgId route (tested via component rendering with orgId prop)
 *
 * Uses React Testing Library with fireEvent for interactions.
 * Since Admin now uses useApi(), useAuth(), useParams(), and useAdminTierGate()
 * internally, tests mock those modules instead of passing props.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act, fireEvent, waitFor } from "@testing-library/react";
import { Admin } from "./Admin";
import type {
  OrgDetails,
  OrgMember,
  OrgPolicy,
  MemberUsage,
  OrgRole,
  CreatePolicyPayload,
  UpdatePolicyPayload,
} from "../lib/admin";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const ORG_ID = "org_test123";
const ADMIN_USER_ID = "user_admin1";
const MEMBER_USER_ID = "user_member1";

const MOCK_ORG: OrgDetails = {
  org_id: ORG_ID,
  name: "Test Organization",
  owner_user_id: ADMIN_USER_ID,
  settings_json: "{}",
  created_at: "2026-01-01T00:00:00Z",
};

const MOCK_MEMBERS: OrgMember[] = [
  {
    user_id: ADMIN_USER_ID,
    email: "admin@testorg.com",
    role: "admin",
    joined_at: "2026-01-01T00:00:00Z",
  },
  {
    user_id: MEMBER_USER_ID,
    email: "member@testorg.com",
    role: "member",
    joined_at: "2026-01-15T00:00:00Z",
  },
  {
    user_id: "user_member2",
    email: "member2@testorg.com",
    role: "member",
    joined_at: "2026-02-01T00:00:00Z",
  },
];

const MOCK_POLICIES: OrgPolicy[] = [
  {
    policy_id: "pol_1",
    org_id: ORG_ID,
    policy_type: "mandatory_working_hours",
    config_json: '{"start_hour":9,"end_hour":17}',
    created_at: "2026-01-10T00:00:00Z",
    created_by: ADMIN_USER_ID,
  },
  {
    policy_id: "pol_2",
    org_id: ORG_ID,
    policy_type: "max_account_count",
    config_json: '{"max_accounts":5}',
    created_at: "2026-01-15T00:00:00Z",
    created_by: ADMIN_USER_ID,
  },
];

const MOCK_USAGE: MemberUsage[] = [
  {
    user_id: ADMIN_USER_ID,
    email: "admin@testorg.com",
    role: "admin",
    accounts_used: 3,
    features_active: ["calendar_sync", "scheduling", "governance"],
    last_sync: "2026-02-15T10:30:00Z",
  },
  {
    user_id: MEMBER_USER_ID,
    email: "member@testorg.com",
    role: "member",
    accounts_used: 1,
    features_active: ["calendar_sync"],
    last_sync: "2026-02-14T16:00:00Z",
  },
  {
    user_id: "user_member2",
    email: "member2@testorg.com",
    role: "member",
    accounts_used: 0,
    features_active: [],
    last_sync: null,
  },
];

// ---------------------------------------------------------------------------
// Mock the API provider, auth, router, and route-helpers
// ---------------------------------------------------------------------------

const mockFetchOrgDetails = vi.fn<(orgId: string) => Promise<OrgDetails>>();
const mockFetchOrgMembers = vi.fn<(orgId: string) => Promise<OrgMember[]>>();
const mockAddOrgMember = vi.fn<(orgId: string, userId: string, role: OrgRole) => Promise<void>>();
const mockRemoveOrgMember = vi.fn<(orgId: string, userId: string) => Promise<void>>();
const mockChangeOrgMemberRole = vi.fn<(orgId: string, userId: string, role: OrgRole) => Promise<void>>();
const mockFetchOrgPolicies = vi.fn<(orgId: string) => Promise<OrgPolicy[]>>();
const mockCreateOrgPolicy = vi.fn<(orgId: string, payload: CreatePolicyPayload) => Promise<void>>();
const mockUpdateOrgPolicy = vi.fn<(orgId: string, policyId: string, payload: UpdatePolicyPayload) => Promise<void>>();
const mockDeleteOrgPolicy = vi.fn<(orgId: string, policyId: string) => Promise<void>>();
const mockFetchOrgUsage = vi.fn<(orgId: string) => Promise<MemberUsage[]>>();
const mockFetchBillingStatus = vi.fn<() => Promise<{ tier: string }>>();

const mockApiValue = {
  fetchOrgDetails: mockFetchOrgDetails,
  fetchOrgMembers: mockFetchOrgMembers,
  addOrgMember: mockAddOrgMember,
  removeOrgMember: mockRemoveOrgMember,
  changeOrgMemberRole: mockChangeOrgMemberRole,
  fetchOrgPolicies: mockFetchOrgPolicies,
  createOrgPolicy: mockCreateOrgPolicy,
  updateOrgPolicy: mockUpdateOrgPolicy,
  deleteOrgPolicy: mockDeleteOrgPolicy,
  fetchOrgUsage: mockFetchOrgUsage,
  fetchBillingStatus: mockFetchBillingStatus,
};

vi.mock("../lib/api-provider", () => ({
  useApi: () => mockApiValue,
  ApiProvider: ({ children }: { children: React.ReactNode }) => children,
}));

let mockCurrentUserId = ADMIN_USER_ID;

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    token: "test-jwt-token",
    refreshToken: "test-refresh-token",
    user: { id: mockCurrentUserId, email: "test@example.com" },
    login: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ orgId: ORG_ID }),
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
  };
});

let mockUserTier = "enterprise";

vi.mock("../lib/route-helpers", () => ({
  useAdminTierGate: () => mockUserTier,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDefaultMocks(overrides: {
  fetchOrgDetails?: () => Promise<OrgDetails>;
  fetchOrgMembers?: () => Promise<OrgMember[]>;
  addOrgMember?: () => Promise<void>;
  removeOrgMember?: () => Promise<void>;
  changeOrgMemberRole?: () => Promise<void>;
  fetchOrgPolicies?: () => Promise<OrgPolicy[]>;
  createOrgPolicy?: () => Promise<void>;
  updateOrgPolicy?: () => Promise<void>;
  deleteOrgPolicy?: () => Promise<void>;
  fetchOrgUsage?: () => Promise<MemberUsage[]>;
  currentUserId?: string;
  userTier?: string;
} = {}) {
  mockCurrentUserId = overrides.currentUserId ?? ADMIN_USER_ID;
  mockUserTier = overrides.userTier ?? "enterprise";

  if (overrides.fetchOrgDetails) {
    mockFetchOrgDetails.mockImplementation(overrides.fetchOrgDetails as never);
  } else {
    mockFetchOrgDetails.mockResolvedValue(MOCK_ORG);
  }
  if (overrides.fetchOrgMembers) {
    mockFetchOrgMembers.mockImplementation(overrides.fetchOrgMembers as never);
  } else {
    mockFetchOrgMembers.mockResolvedValue(MOCK_MEMBERS);
  }
  mockAddOrgMember.mockImplementation(
    (overrides.addOrgMember ?? (async () => {})) as never,
  );
  mockRemoveOrgMember.mockImplementation(
    (overrides.removeOrgMember ?? (async () => {})) as never,
  );
  mockChangeOrgMemberRole.mockImplementation(
    (overrides.changeOrgMemberRole ?? (async () => {})) as never,
  );
  if (overrides.fetchOrgPolicies) {
    mockFetchOrgPolicies.mockImplementation(overrides.fetchOrgPolicies as never);
  } else {
    mockFetchOrgPolicies.mockResolvedValue(MOCK_POLICIES);
  }
  mockCreateOrgPolicy.mockImplementation(
    (overrides.createOrgPolicy ?? (async () => {})) as never,
  );
  mockUpdateOrgPolicy.mockImplementation(
    (overrides.updateOrgPolicy ?? (async () => {})) as never,
  );
  mockDeleteOrgPolicy.mockImplementation(
    (overrides.deleteOrgPolicy ?? (async () => {})) as never,
  );
  if (overrides.fetchOrgUsage) {
    mockFetchOrgUsage.mockImplementation(overrides.fetchOrgUsage as never);
  } else {
    mockFetchOrgUsage.mockResolvedValue(MOCK_USAGE);
  }
  mockFetchBillingStatus.mockResolvedValue({ tier: mockUserTier });
}

async function renderAdmin(overrides: Parameters<typeof setupDefaultMocks>[0] = {}) {
  setupDefaultMocks(overrides);
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<Admin />);
  });
  return result!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCurrentUserId = ADMIN_USER_ID;
  mockUserTier = "enterprise";
});

// ---------------------------------------------------------------------------
// AC5: Enterprise tier enforced
// ---------------------------------------------------------------------------

describe("AC5: Enterprise tier enforcement", () => {
  it("shows upgrade prompt for non-enterprise users", async () => {
    await renderAdmin({ userTier: "free" });
    expect(screen.getByTestId("admin-upgrade-prompt")).toBeInTheDocument();
    expect(screen.getByText("Enterprise Tier Required")).toBeInTheDocument();
    expect(screen.getByText("Upgrade Plan")).toBeInTheDocument();
  });

  it("upgrade link points to billing page", async () => {
    await renderAdmin({ userTier: "pro" });
    const link = screen.getByText("Upgrade Plan");
    expect(link.closest("a")).toHaveAttribute("href", "#/billing");
  });

  it("does NOT show upgrade prompt for enterprise users", async () => {
    await renderAdmin({ userTier: "enterprise" });
    expect(screen.queryByTestId("admin-upgrade-prompt")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC6: Accessible at /admin/:orgId route
// ---------------------------------------------------------------------------

describe("AC6: Route rendering with orgId", () => {
  it("renders admin console with org name", async () => {
    await renderAdmin();
    expect(screen.getByTestId("admin-console")).toBeInTheDocument();
    expect(screen.getByTestId("org-name")).toHaveTextContent("Test Organization");
  });

  it("passes orgId to all fetch functions", async () => {
    await renderAdmin();
    expect(mockFetchOrgDetails).toHaveBeenCalledWith(ORG_ID);
    expect(mockFetchOrgMembers).toHaveBeenCalledWith(ORG_ID);
    expect(mockFetchOrgPolicies).toHaveBeenCalledWith(ORG_ID);
    expect(mockFetchOrgUsage).toHaveBeenCalledWith(ORG_ID);
  });

  it("shows loading state while org is loading", async () => {
    // Create a deferred promise so we can control when loading finishes
    let resolveOrgDetails!: (value: OrgDetails) => void;
    const fetchOrgDetails = vi.fn(
      () => new Promise<OrgDetails>((resolve) => { resolveOrgDetails = resolve; }),
    );
    setupDefaultMocks({ fetchOrgDetails: fetchOrgDetails as () => Promise<OrgDetails> });
    await act(async () => {
      render(<Admin />);
    });
    expect(screen.getByTestId("admin-loading")).toBeInTheDocument();

    // Resolve and verify loading goes away
    await act(async () => {
      resolveOrgDetails(MOCK_ORG);
    });
    expect(screen.queryByTestId("admin-loading")).not.toBeInTheDocument();
  });

  it("shows error state when org fetch fails", async () => {
    await renderAdmin({
      fetchOrgDetails: async () => { throw new Error("Org not found"); },
    });
    expect(screen.getByTestId("admin-error")).toBeInTheDocument();
    expect(screen.getByText(/Org not found/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC1: Admin can view and manage org members
// ---------------------------------------------------------------------------

describe("AC1: Admin member management", () => {
  it("displays all org members with roles", async () => {
    await renderAdmin();

    // Verify each member is displayed
    expect(screen.getByTestId(`member-row-${ADMIN_USER_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`member-row-${MEMBER_USER_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId("member-row-user_member2")).toBeInTheDocument();

    // Verify email display
    expect(screen.getByTestId(`member-email-${ADMIN_USER_ID}`)).toHaveTextContent("admin@testorg.com");
    expect(screen.getByTestId(`member-email-${MEMBER_USER_ID}`)).toHaveTextContent("member@testorg.com");

    // Verify role display
    expect(screen.getByTestId(`member-role-${ADMIN_USER_ID}`)).toHaveTextContent("admin");
    expect(screen.getByTestId(`member-role-${MEMBER_USER_ID}`)).toHaveTextContent("member");
  });

  it("admin sees add member form", async () => {
    await renderAdmin();
    expect(screen.getByTestId("add-member-form")).toBeInTheDocument();
    expect(screen.getByTestId("new-member-id-input")).toBeInTheDocument();
    expect(screen.getByTestId("new-member-role-select")).toBeInTheDocument();
    expect(screen.getByTestId("add-member-btn")).toBeInTheDocument();
  });

  it("admin sees remove buttons for each member", async () => {
    await renderAdmin();
    expect(screen.getByTestId(`remove-member-btn-${ADMIN_USER_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`remove-member-btn-${MEMBER_USER_ID}`)).toBeInTheDocument();
  });

  it("admin sees promote/demote buttons", async () => {
    await renderAdmin();
    // Admin user should have "Demote" button
    expect(screen.getByTestId(`change-role-btn-${ADMIN_USER_ID}`)).toHaveTextContent("Demote");
    // Member user should have "Promote" button
    expect(screen.getByTestId(`change-role-btn-${MEMBER_USER_ID}`)).toHaveTextContent("Promote");
  });

  it("admin can add a member via form", async () => {
    await renderAdmin();

    // Fill in the form
    const idInput = screen.getByTestId("new-member-id-input");
    const roleSelect = screen.getByTestId("new-member-role-select");
    const addBtn = screen.getByTestId("add-member-btn");

    await act(async () => {
      fireEvent.change(idInput, { target: { value: "user_new123" } });
      fireEvent.change(roleSelect, { target: { value: "member" } });
    });

    await act(async () => {
      fireEvent.click(addBtn);
    });

    expect(mockAddOrgMember).toHaveBeenCalledWith(ORG_ID, "user_new123", "member");
  });

  it("admin can remove a member", async () => {
    await renderAdmin();

    const removeBtn = screen.getByTestId(`remove-member-btn-${MEMBER_USER_ID}`);
    await act(async () => {
      fireEvent.click(removeBtn);
    });

    expect(mockRemoveOrgMember).toHaveBeenCalledWith(ORG_ID, MEMBER_USER_ID);
  });

  it("admin can change a member's role", async () => {
    await renderAdmin();

    const promoteBtn = screen.getByTestId(`change-role-btn-${MEMBER_USER_ID}`);
    await act(async () => {
      fireEvent.click(promoteBtn);
    });

    expect(mockChangeOrgMemberRole).toHaveBeenCalledWith(ORG_ID, MEMBER_USER_ID, "admin");
  });

  it("shows admin badge in header for admin users", async () => {
    await renderAdmin();
    expect(screen.getByTestId("admin-badge")).toBeInTheDocument();
    expect(screen.getByTestId("admin-badge")).toHaveTextContent("ADMIN");
  });

  it("shows error when add member fails", async () => {
    setupDefaultMocks({
      addOrgMember: async () => { throw new Error("User not found"); },
    });
    await act(async () => {
      render(<Admin />);
    });

    const idInput = screen.getByTestId("new-member-id-input");
    const addBtn = screen.getByTestId("add-member-btn");

    await act(async () => {
      fireEvent.change(idInput, { target: { value: "invalid_user" } });
    });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    expect(screen.getByTestId("member-action-error")).toHaveTextContent("User not found");
  });

  it("add button is disabled when input is empty", async () => {
    await renderAdmin();
    const addBtn = screen.getByTestId("add-member-btn");
    expect(addBtn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// AC2: Admin can create/edit/delete org policies
// ---------------------------------------------------------------------------

describe("AC2: Admin policy management", () => {
  it("displays existing policies with config details", async () => {
    await renderAdmin();

    expect(screen.getByTestId("policy-row-pol_1")).toBeInTheDocument();
    expect(screen.getByTestId("policy-type-pol_1")).toHaveTextContent("Mandatory Working Hours");
    expect(screen.getByTestId("policy-config-pol_1")).toHaveTextContent("start_hour: 9");
    expect(screen.getByTestId("policy-config-pol_1")).toHaveTextContent("end_hour: 17");

    expect(screen.getByTestId("policy-row-pol_2")).toBeInTheDocument();
    expect(screen.getByTestId("policy-type-pol_2")).toHaveTextContent("Max Account Count");
    expect(screen.getByTestId("policy-config-pol_2")).toHaveTextContent("max_accounts: 5");
  });

  it("admin sees create policy button", async () => {
    await renderAdmin();
    expect(screen.getByTestId("create-policy-btn")).toBeInTheDocument();
  });

  it("admin sees edit/delete buttons for each policy", async () => {
    await renderAdmin();
    expect(screen.getByTestId("edit-policy-btn-pol_1")).toBeInTheDocument();
    expect(screen.getByTestId("delete-policy-btn-pol_1")).toBeInTheDocument();
    expect(screen.getByTestId("edit-policy-btn-pol_2")).toBeInTheDocument();
    expect(screen.getByTestId("delete-policy-btn-pol_2")).toBeInTheDocument();
  });

  it("admin can open create policy form", async () => {
    await renderAdmin();

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-policy-btn"));
    });

    expect(screen.getByTestId("policy-form")).toBeInTheDocument();
    expect(screen.getByTestId("policy-type-select")).toBeInTheDocument();
    expect(screen.getByTestId("policy-submit-btn")).toBeInTheDocument();
    expect(screen.getByTestId("policy-cancel-btn")).toBeInTheDocument();
  });

  it("create form only shows available (unused) policy types", async () => {
    await renderAdmin();

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-policy-btn"));
    });

    const select = screen.getByTestId("policy-type-select") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);

    // mandatory_working_hours and max_account_count are already used
    expect(options).not.toContain("mandatory_working_hours");
    expect(options).not.toContain("max_account_count");
    // minimum_vip_priority and required_projection_detail should be available
    expect(options).toContain("minimum_vip_priority");
    expect(options).toContain("required_projection_detail");
  });

  it("admin can create a new policy", async () => {
    await renderAdmin();

    // Open create form
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-policy-btn"));
    });

    // Select minimum_vip_priority (should be first available)
    const select = screen.getByTestId("policy-type-select") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "minimum_vip_priority" } });
    });

    // Fill config
    const weightInput = screen.getByTestId("config-min-weight");
    await act(async () => {
      fireEvent.change(weightInput, { target: { value: "75" } });
    });

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByTestId("policy-submit-btn"));
    });

    expect(mockCreateOrgPolicy).toHaveBeenCalledWith(ORG_ID, {
      policy_type: "minimum_vip_priority",
      config: { min_weight: 75 },
    });
  });

  it("admin can open edit form for existing policy", async () => {
    await renderAdmin();

    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-policy-btn-pol_1"));
    });

    expect(screen.getByTestId("policy-form")).toBeInTheDocument();
    // Should show config fields with existing values
    const startHour = screen.getByTestId("config-start-hour") as HTMLInputElement;
    const endHour = screen.getByTestId("config-end-hour") as HTMLInputElement;
    expect(startHour.value).toBe("9");
    expect(endHour.value).toBe("17");
  });

  it("admin can update an existing policy", async () => {
    await renderAdmin();

    // Open edit form for pol_1
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-policy-btn-pol_1"));
    });

    // Change end_hour
    const endHour = screen.getByTestId("config-end-hour");
    await act(async () => {
      fireEvent.change(endHour, { target: { value: "18" } });
    });

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByTestId("policy-submit-btn"));
    });

    expect(mockUpdateOrgPolicy).toHaveBeenCalledWith(ORG_ID, "pol_1", {
      config: { start_hour: 9, end_hour: 18 },
    });
  });

  it("admin can delete a policy", async () => {
    await renderAdmin();

    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-policy-btn-pol_2"));
    });

    expect(mockDeleteOrgPolicy).toHaveBeenCalledWith(ORG_ID, "pol_2");
  });

  it("shows validation error for invalid policy config", async () => {
    await renderAdmin();

    // Open create form
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-policy-btn"));
    });

    // Select minimum_vip_priority
    await act(async () => {
      fireEvent.change(screen.getByTestId("policy-type-select"), {
        target: { value: "minimum_vip_priority" },
      });
    });

    // Set invalid weight
    await act(async () => {
      fireEvent.change(screen.getByTestId("config-min-weight"), {
        target: { value: "150" },
      });
    });

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByTestId("policy-submit-btn"));
    });

    expect(screen.getByTestId("policy-form-error")).toHaveTextContent(
      "min_weight must be between 0 and 100",
    );
  });

  it("cancel button closes the form", async () => {
    await renderAdmin();

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-policy-btn"));
    });
    expect(screen.getByTestId("policy-form")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("policy-cancel-btn"));
    });
    expect(screen.queryByTestId("policy-form")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC3: Usage dashboard shows per-member stats
// ---------------------------------------------------------------------------

describe("AC3: Usage dashboard", () => {
  it("displays usage table with all members", async () => {
    await renderAdmin();

    expect(screen.getByTestId("usage-table")).toBeInTheDocument();
    expect(screen.getByTestId(`usage-row-${ADMIN_USER_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`usage-row-${MEMBER_USER_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId("usage-row-user_member2")).toBeInTheDocument();
  });

  it("shows per-member email", async () => {
    await renderAdmin();
    expect(screen.getByTestId(`usage-email-${ADMIN_USER_ID}`)).toHaveTextContent("admin@testorg.com");
    expect(screen.getByTestId(`usage-email-${MEMBER_USER_ID}`)).toHaveTextContent("member@testorg.com");
  });

  it("shows per-member accounts used count", async () => {
    await renderAdmin();
    expect(screen.getByTestId(`usage-accounts-${ADMIN_USER_ID}`)).toHaveTextContent("3");
    expect(screen.getByTestId(`usage-accounts-${MEMBER_USER_ID}`)).toHaveTextContent("1");
    expect(screen.getByTestId("usage-accounts-user_member2")).toHaveTextContent("0");
  });

  it("shows features active for each member", async () => {
    await renderAdmin();
    expect(screen.getByTestId(`usage-features-${ADMIN_USER_ID}`)).toHaveTextContent(
      "calendar_sync, scheduling, governance",
    );
    expect(screen.getByTestId(`usage-features-${MEMBER_USER_ID}`)).toHaveTextContent("calendar_sync");
    expect(screen.getByTestId("usage-features-user_member2")).toHaveTextContent("None");
  });

  it("shows last sync timestamp", async () => {
    await renderAdmin();
    // Admin has a valid sync time
    const adminSync = screen.getByTestId(`usage-sync-${ADMIN_USER_ID}`);
    expect(adminSync.textContent).not.toBe("Never");

    // Member2 has null last_sync
    const member2Sync = screen.getByTestId("usage-sync-user_member2");
    expect(member2Sync).toHaveTextContent("Never");
  });

  it("shows role for each member", async () => {
    await renderAdmin();
    expect(screen.getByTestId(`usage-role-${ADMIN_USER_ID}`)).toHaveTextContent("admin");
    expect(screen.getByTestId(`usage-role-${MEMBER_USER_ID}`)).toHaveTextContent("member");
  });

  it("shows empty state when no usage data", async () => {
    await renderAdmin({ fetchOrgUsage: async () => [] });
    expect(screen.getByTestId("usage-empty")).toBeInTheDocument();
    expect(screen.getByTestId("usage-empty")).toHaveTextContent("No usage data available");
  });
});

// ---------------------------------------------------------------------------
// AC4: Members see read-only view
// ---------------------------------------------------------------------------

describe("AC4: Member read-only view", () => {
  it("member does NOT see add member form", async () => {
    await renderAdmin({ currentUserId: MEMBER_USER_ID });
    expect(screen.queryByTestId("add-member-form")).not.toBeInTheDocument();
  });

  it("member does NOT see remove member buttons", async () => {
    await renderAdmin({ currentUserId: MEMBER_USER_ID });
    expect(screen.queryByTestId(`remove-member-btn-${ADMIN_USER_ID}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`remove-member-btn-${MEMBER_USER_ID}`)).not.toBeInTheDocument();
  });

  it("member does NOT see promote/demote buttons", async () => {
    await renderAdmin({ currentUserId: MEMBER_USER_ID });
    expect(screen.queryByTestId(`change-role-btn-${ADMIN_USER_ID}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`change-role-btn-${MEMBER_USER_ID}`)).not.toBeInTheDocument();
  });

  it("member does NOT see create policy button", async () => {
    await renderAdmin({ currentUserId: MEMBER_USER_ID });
    expect(screen.queryByTestId("create-policy-btn")).not.toBeInTheDocument();
  });

  it("member does NOT see edit/delete policy buttons", async () => {
    await renderAdmin({ currentUserId: MEMBER_USER_ID });
    expect(screen.queryByTestId("edit-policy-btn-pol_1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delete-policy-btn-pol_1")).not.toBeInTheDocument();
  });

  it("member does NOT see admin badge", async () => {
    await renderAdmin({ currentUserId: MEMBER_USER_ID });
    expect(screen.queryByTestId("admin-badge")).not.toBeInTheDocument();
  });

  it("member CAN see member list (read-only)", async () => {
    await renderAdmin({ currentUserId: MEMBER_USER_ID });
    expect(screen.getByTestId("member-list")).toBeInTheDocument();
    expect(screen.getByTestId(`member-email-${ADMIN_USER_ID}`)).toHaveTextContent("admin@testorg.com");
  });

  it("member CAN see policy list (read-only)", async () => {
    await renderAdmin({ currentUserId: MEMBER_USER_ID });
    expect(screen.getByTestId("policy-row-pol_1")).toBeInTheDocument();
    expect(screen.getByTestId("policy-type-pol_1")).toHaveTextContent("Mandatory Working Hours");
  });

  it("member CAN see usage dashboard", async () => {
    await renderAdmin({ currentUserId: MEMBER_USER_ID });
    expect(screen.getByTestId("usage-table")).toBeInTheDocument();
  });

  it("non-member sees access denied", async () => {
    await renderAdmin({ currentUserId: "user_outsider" });
    expect(screen.getByTestId("admin-access-denied")).toBeInTheDocument();
    expect(screen.getByText("You are not a member of this organization.")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  it("shows member loading state", async () => {
    let resolveFn!: (value: OrgMember[]) => void;
    setupDefaultMocks({
      fetchOrgMembers: () => new Promise<OrgMember[]>((resolve) => { resolveFn = resolve; }),
    });
    await act(async () => {
      render(<Admin />);
    });
    expect(screen.getByTestId("member-list-loading")).toBeInTheDocument();

    await act(async () => {
      resolveFn(MOCK_MEMBERS);
    });
  });

  it("shows policy loading state", async () => {
    let resolveFn!: (value: OrgPolicy[]) => void;
    setupDefaultMocks({
      fetchOrgPolicies: () => new Promise<OrgPolicy[]>((resolve) => { resolveFn = resolve; }),
    });
    await act(async () => {
      render(<Admin />);
    });
    expect(screen.getByTestId("policy-editor-loading")).toBeInTheDocument();

    await act(async () => {
      resolveFn(MOCK_POLICIES);
    });
  });

  it("shows usage loading state", async () => {
    let resolveFn!: (value: MemberUsage[]) => void;
    setupDefaultMocks({
      fetchOrgUsage: () => new Promise<MemberUsage[]>((resolve) => { resolveFn = resolve; }),
    });
    await act(async () => {
      render(<Admin />);
    });
    expect(screen.getByTestId("usage-dashboard-loading")).toBeInTheDocument();

    await act(async () => {
      resolveFn(MOCK_USAGE);
    });
  });

  it("shows members error with retry when member fetch fails", async () => {
    // When members fail to load, the component shows an error with retry,
    // NOT access denied (since we can't verify membership status).
    await renderAdmin({
      fetchOrgMembers: async () => { throw new Error("Members fetch failed"); },
    });
    expect(screen.getByTestId("admin-members-error")).toBeInTheDocument();
    expect(screen.getByText(/Members fetch failed/)).toBeInTheDocument();
  });

  it("shows policy editor error", async () => {
    await renderAdmin({
      fetchOrgPolicies: async () => { throw new Error("Policies fetch failed"); },
    });
    expect(screen.getByTestId("policy-editor-error")).toBeInTheDocument();
  });

  it("shows usage dashboard error", async () => {
    await renderAdmin({
      fetchOrgUsage: async () => { throw new Error("Usage fetch failed"); },
    });
    expect(screen.getByTestId("usage-dashboard-error")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Integration: admin creates policy via UI flow
// ---------------------------------------------------------------------------

describe("Integration: policy creation flow", () => {
  it("creates policy, form closes, and reload is triggered", async () => {
    setupDefaultMocks();
    await act(async () => {
      render(<Admin />);
    });

    // fetchOrgPolicies called once on mount
    expect(mockFetchOrgPolicies).toHaveBeenCalledTimes(1);

    // Open create form
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-policy-btn"));
    });

    // Select policy type
    await act(async () => {
      fireEvent.change(screen.getByTestId("policy-type-select"), {
        target: { value: "minimum_vip_priority" },
      });
    });

    // Fill config
    await act(async () => {
      fireEvent.change(screen.getByTestId("config-min-weight"), {
        target: { value: "60" },
      });
    });

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByTestId("policy-submit-btn"));
    });

    // Verify create was called with correct args
    expect(mockCreateOrgPolicy).toHaveBeenCalledWith(ORG_ID, {
      policy_type: "minimum_vip_priority",
      config: { min_weight: 60 },
    });

    // Verify form closed
    expect(screen.queryByTestId("policy-form")).not.toBeInTheDocument();

    // Verify policies were reloaded
    expect(mockFetchOrgPolicies).toHaveBeenCalledTimes(2);
  });
});
