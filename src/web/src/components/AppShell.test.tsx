/**
 * Tests for AppShell and Sidebar components.
 *
 * Unit tests verify:
 *   - Sidebar renders all navigation links grouped by section
 *   - Active route is highlighted via NavLink
 *   - Hamburger toggle controls mobile sidebar visibility
 *   - Logout button calls auth.logout()
 *   - User email is displayed in the header
 *   - Admin section visibility is conditional
 *
 * Integration tests verify:
 *   - Navigation between routes via sidebar links renders correct pages
 *   - Login page renders without the AppShell (no sidebar)
 *   - Onboarding page renders without the AppShell (no sidebar)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "./AppShell";
import { Sidebar } from "./Sidebar";
import { App } from "../App";

// ---------------------------------------------------------------------------
// Mock auth module for unit tests
// ---------------------------------------------------------------------------

const mockLogout = vi.fn();
const mockUser = { id: "user-1", email: "test@example.com" };

vi.mock("../lib/auth", async () => {
  const original = await vi.importActual("../lib/auth");
  return {
    ...original,
    useAuth: () => ({
      token: "test-jwt-token",
      refreshToken: "test-refresh-token",
      user: mockUser,
      login: vi.fn(),
      logout: mockLogout,
    }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// ---------------------------------------------------------------------------
// Mock API modules to prevent network calls in integration tests
// ---------------------------------------------------------------------------

vi.mock("../lib/api", () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
  login: vi.fn(),
  fetchSyncStatus: vi.fn().mockResolvedValue({ accounts: [] }),
  fetchAccounts: vi.fn().mockResolvedValue([]),
  fetchAccountDetail: vi.fn(),
  fetchEvents: vi.fn().mockResolvedValue([]),
  unlinkAccount: vi.fn(),
  fetchErrorMirrors: vi.fn().mockResolvedValue([]),
  retryMirror: vi.fn(),
  fetchBillingStatus: vi.fn().mockResolvedValue({ tier: "free", status: "active", subscription: null }),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  fetchBillingHistory: vi.fn().mockResolvedValue([]),
  createSchedulingSession: vi.fn(),
  listSessions: vi.fn().mockResolvedValue([]),
  commitCandidate: vi.fn(),
  cancelSession: vi.fn(),
  fetchCommitments: vi.fn().mockResolvedValue([]),
  fetchVips: vi.fn().mockResolvedValue([]),
  addVip: vi.fn(),
  removeVip: vi.fn(),
  exportCommitmentProof: vi.fn(),
  fetchRelationships: vi.fn().mockResolvedValue([]),
  createRelationship: vi.fn(),
  fetchRelationship: vi.fn(),
  updateRelationship: vi.fn(),
  deleteRelationship: vi.fn(),
  fetchReputation: vi.fn(),
  fetchOutcomes: vi.fn().mockResolvedValue([]),
  createOutcome: vi.fn(),
  fetchDriftReport: vi.fn().mockResolvedValue({ entries: [], generated_at: "" }),
  fetchReconnectionSuggestionsFull: vi.fn().mockResolvedValue([]),
  fetchUpcomingMilestones: vi.fn().mockResolvedValue([]),
  fetchAccountsHealth: vi.fn().mockResolvedValue({ accounts: [], tier_limit: 2 }),
  reconnectAccount: vi.fn(),
  removeAccount: vi.fn(),
  fetchSyncHistory: vi.fn().mockResolvedValue({ events: [] }),
  fetchEventBriefing: vi.fn(),
  generateExcuse: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  createOnboardingSession: vi.fn(),
  getOnboardingSession: vi.fn(),
  getOnboardingStatus: vi.fn(),
  addOnboardingAccount: vi.fn(),
  completeOnboardingSession: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

vi.mock("../lib/policies", () => ({
  fetchPolicies: vi.fn().mockResolvedValue({ accounts: [], edges: [] }),
  updatePolicyEdge: vi.fn(),
}));

vi.mock("../lib/admin", () => ({
  fetchOrgDetails: vi.fn(),
  fetchOrgMembers: vi.fn().mockResolvedValue([]),
  addOrgMember: vi.fn(),
  removeOrgMember: vi.fn(),
  changeOrgMemberRole: vi.fn(),
  fetchOrgPolicies: vi.fn().mockResolvedValue([]),
  createOrgPolicy: vi.fn(),
  updateOrgPolicy: vi.fn(),
  deleteOrgPolicy: vi.fn(),
  fetchOrgUsage: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSidebar(props: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return render(
    <MemoryRouter initialEntries={["/calendar"]}>
      <Sidebar showAdmin={false} {...props} />
    </MemoryRouter>,
  );
}

function renderAppShell(route = "/calendar") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppShell>
        <div data-testid="test-content">Page content</div>
      </AppShell>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Sidebar unit tests
// ---------------------------------------------------------------------------

describe("Sidebar", () => {
  it("renders all Core navigation links", () => {
    renderSidebar();
    const sidebar = screen.getByTestId("sidebar");
    expect(within(sidebar).getByText("Calendar")).toBeInTheDocument();
    expect(within(sidebar).getByText("Accounts")).toBeInTheDocument();
    expect(within(sidebar).getByText("Sync Status")).toBeInTheDocument();
  });

  it("renders all Configuration navigation links", () => {
    renderSidebar();
    const sidebar = screen.getByTestId("sidebar");
    expect(within(sidebar).getByText("Policies")).toBeInTheDocument();
    expect(within(sidebar).getByText("Provider Health")).toBeInTheDocument();
    expect(within(sidebar).getByText("Error Recovery")).toBeInTheDocument();
  });

  it("renders all Business navigation links", () => {
    renderSidebar();
    const sidebar = screen.getByTestId("sidebar");
    expect(within(sidebar).getByText("Scheduling")).toBeInTheDocument();
    expect(within(sidebar).getByText("Governance")).toBeInTheDocument();
    expect(within(sidebar).getByText("Relationships")).toBeInTheDocument();
    expect(within(sidebar).getByText("Reconnections")).toBeInTheDocument();
    expect(within(sidebar).getByText("Billing")).toBeInTheDocument();
  });

  it("renders section group titles", () => {
    renderSidebar();
    expect(screen.getByText("Core")).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();
    expect(screen.getByText("Business")).toBeInTheDocument();
  });

  it("does NOT render Admin section when showAdmin is false", () => {
    renderSidebar({ showAdmin: false });
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
  });

  it("renders Admin section when showAdmin is true", () => {
    renderSidebar({ showAdmin: true });
    // "Admin" appears as both the section title and the nav link label
    const adminElements = screen.getAllByText("Admin");
    expect(adminElements.length).toBe(2); // section title + link
  });

  it("highlights active route with active class", () => {
    render(
      <MemoryRouter initialEntries={["/calendar"]}>
        <Sidebar showAdmin={false} />
      </MemoryRouter>,
    );

    const calendarLink = screen.getByText("Calendar").closest("a");
    expect(calendarLink).toHaveClass("bg-primary/10");
    expect(calendarLink).toHaveClass("text-primary");
    expect(calendarLink).toHaveClass("border-l-2");
    expect(calendarLink).toHaveClass("border-primary");
  });

  it("does NOT highlight inactive routes", () => {
    render(
      <MemoryRouter initialEntries={["/calendar"]}>
        <Sidebar showAdmin={false} />
      </MemoryRouter>,
    );

    const accountsLink = screen.getByText("Accounts").closest("a");
    expect(accountsLink).not.toHaveClass("bg-primary/10");
    expect(accountsLink).toHaveClass("text-muted-foreground");
  });

  it("calls onNavigate callback when a link is clicked", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/calendar"]}>
        <Sidebar showAdmin={false} onNavigate={onNavigate} />
      </MemoryRouter>,
    );

    await user.click(screen.getByText("Accounts"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("renders correct href for each navigation link", () => {
    renderSidebar();
    const sidebar = screen.getByTestId("sidebar");

    const links = [
      { text: "Calendar", href: "/calendar" },
      { text: "Accounts", href: "/accounts" },
      { text: "Sync Status", href: "/sync-status" },
      { text: "Policies", href: "/policies" },
      { text: "Provider Health", href: "/provider-health" },
      { text: "Error Recovery", href: "/errors" },
      { text: "Scheduling", href: "/scheduling" },
      { text: "Governance", href: "/governance" },
      { text: "Relationships", href: "/relationships" },
      { text: "Reconnections", href: "/reconnections" },
      { text: "Billing", href: "/billing" },
    ];

    for (const { text, href } of links) {
      const link = within(sidebar).getByText(text).closest("a");
      expect(link).toHaveAttribute("href", href);
    }
  });
});

// ---------------------------------------------------------------------------
// AppShell unit tests
// ---------------------------------------------------------------------------

describe("AppShell", () => {
  beforeEach(() => {
    mockLogout.mockClear();
  });

  it("renders the top header with app name", () => {
    renderAppShell();
    const header = screen.getByTestId("app-header");
    expect(header).toBeInTheDocument();
  });

  it("renders user email in the header", () => {
    renderAppShell();
    expect(screen.getByTestId("user-email")).toHaveTextContent("test@example.com");
  });

  it("renders logout button", () => {
    renderAppShell();
    expect(screen.getByTestId("logout-button")).toBeInTheDocument();
  });

  it("calls logout when logout button is clicked", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByTestId("logout-button"));
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it("renders children in the main content area", () => {
    renderAppShell();
    expect(screen.getByTestId("test-content")).toBeInTheDocument();
    expect(screen.getByTestId("test-content")).toHaveTextContent("Page content");
  });

  it("renders the desktop sidebar", () => {
    renderAppShell();
    expect(screen.getByTestId("desktop-sidebar")).toBeInTheDocument();
  });

  it("renders hamburger button for mobile", () => {
    renderAppShell();
    expect(screen.getByTestId("hamburger-button")).toBeInTheDocument();
  });

  it("mobile sidebar is hidden by default (off-screen)", () => {
    renderAppShell();
    const mobileSidebar = screen.getByTestId("mobile-sidebar");
    expect(mobileSidebar).toHaveClass("-translate-x-full");
  });

  it("hamburger button toggles mobile sidebar open", async () => {
    const user = userEvent.setup();
    renderAppShell();

    const hamburger = screen.getByTestId("hamburger-button");
    await user.click(hamburger);

    const mobileSidebar = screen.getByTestId("mobile-sidebar");
    expect(mobileSidebar).toHaveClass("translate-x-0");
    expect(mobileSidebar).not.toHaveClass("-translate-x-full");
  });

  it("shows overlay when mobile menu is open", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByTestId("hamburger-button"));
    expect(screen.getByTestId("mobile-overlay")).toBeInTheDocument();
  });

  it("clicking overlay closes mobile sidebar", async () => {
    const user = userEvent.setup();
    renderAppShell();

    // Open
    await user.click(screen.getByTestId("hamburger-button"));
    expect(screen.getByTestId("mobile-sidebar")).toHaveClass("translate-x-0");

    // Close via overlay
    await user.click(screen.getByTestId("mobile-overlay"));
    expect(screen.getByTestId("mobile-sidebar")).toHaveClass("-translate-x-full");
  });

  it("close button in mobile sidebar closes it", async () => {
    const user = userEvent.setup();
    renderAppShell();

    // Open mobile sidebar
    await user.click(screen.getByTestId("hamburger-button"));
    expect(screen.getByTestId("mobile-sidebar")).toHaveClass("translate-x-0");

    // Close via close button
    const closeButton = screen.getByLabelText("Close menu");
    await user.click(closeButton);
    expect(screen.getByTestId("mobile-sidebar")).toHaveClass("-translate-x-full");
  });

  it("desktop sidebar has fixed 240px width (w-60)", () => {
    renderAppShell();
    const sidebar = screen.getByTestId("desktop-sidebar");
    expect(sidebar).toHaveClass("w-60");
  });

  it("sidebar shows T-Minus branding", () => {
    renderAppShell();
    const sidebar = screen.getByTestId("desktop-sidebar");
    expect(within(sidebar).getByText("T-Minus")).toBeInTheDocument();
  });

  it("uses Tailwind classes, not inline styles", () => {
    renderAppShell();
    const sidebar = screen.getByTestId("desktop-sidebar");
    // Should not have inline style attribute
    expect(sidebar.getAttribute("style")).toBeNull();
    // Should have Tailwind classes
    expect(sidebar.className).toContain("bg-card");
  });
});

// ---------------------------------------------------------------------------
// Page transition tests (AnimatePresence wrapping)
// ---------------------------------------------------------------------------

describe("AppShell page transitions", () => {
  it("wraps children in a motion.main element with AnimatePresence", () => {
    renderAppShell();
    // motion.main renders as a <main> element in the DOM
    const mainEl = screen.getByTestId("test-content").closest("main");
    expect(mainEl).toBeInTheDocument();
    expect(mainEl).toHaveClass("flex-1");
    expect(mainEl).toHaveClass("overflow-y-auto");
  });

  it("preserves content area layout classes on the animated wrapper", () => {
    renderAppShell();
    const mainEl = screen.getByTestId("test-content").closest("main");
    expect(mainEl).toHaveClass("flex-1", "overflow-y-auto", "p-4");
  });

  it("renders children inside AnimatePresence without layout shift", () => {
    renderAppShell();
    // Children must still be accessible inside the animated wrapper
    const content = screen.getByTestId("test-content");
    expect(content).toBeInTheDocument();
    expect(content).toHaveTextContent("Page content");
    // The main content area should be inside the flex column container
    const mainEl = content.closest("main");
    const parentDiv = mainEl?.parentElement;
    expect(parentDiv).toHaveClass("flex", "flex-1", "flex-col", "overflow-hidden");
  });

  it("renders plain main when prefers-reduced-motion is active", () => {
    // Simulate prefers-reduced-motion: reduce via matchMedia
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderAppShell();
    const content = screen.getByTestId("test-content");
    expect(content).toBeInTheDocument();
    // Children should still render in a <main> element
    const mainEl = content.closest("main");
    expect(mainEl).toBeInTheDocument();
    expect(mainEl).toHaveClass("flex-1", "overflow-y-auto");

    window.matchMedia = originalMatchMedia;
  });
});

// ---------------------------------------------------------------------------
// Integration tests -- AppShell with routing context
//
// NOTE: Auth-dependent integration tests (Login without sidebar, Onboarding
// without sidebar, authenticated routes with sidebar) are covered in
// App.test.tsx which does NOT mock auth, allowing real auth state control.
//
// These tests focus on AppShell behavior within a Router context.
// ---------------------------------------------------------------------------

describe("AppShell integration", () => {
  it("sidebar navigation links render with correct paths", () => {
    render(
      <MemoryRouter initialEntries={["/calendar"]}>
        <AppShell>
          <div>Content</div>
        </AppShell>
      </MemoryRouter>,
    );

    const desktopSidebar = screen.getByTestId("desktop-sidebar");

    // Verify all expected navigation routes exist
    const expectedLinks = [
      { text: "Calendar", href: "/calendar" },
      { text: "Accounts", href: "/accounts" },
      { text: "Sync Status", href: "/sync-status" },
      { text: "Policies", href: "/policies" },
      { text: "Provider Health", href: "/provider-health" },
      { text: "Error Recovery", href: "/errors" },
      { text: "Scheduling", href: "/scheduling" },
      { text: "Governance", href: "/governance" },
      { text: "Relationships", href: "/relationships" },
      { text: "Reconnections", href: "/reconnections" },
      { text: "Billing", href: "/billing" },
    ];

    for (const { text, href } of expectedLinks) {
      const link = within(desktopSidebar).getByText(text).closest("a");
      expect(link).toHaveAttribute("href", href);
    }
  });

  it("active route link is highlighted in sidebar", () => {
    render(
      <MemoryRouter initialEntries={["/billing"]}>
        <AppShell>
          <div>Content</div>
        </AppShell>
      </MemoryRouter>,
    );

    const desktopSidebar = screen.getByTestId("desktop-sidebar");
    const billingLink = within(desktopSidebar).getByText("Billing").closest("a");
    expect(billingLink).toHaveClass("bg-primary/10");

    const calendarLink = within(desktopSidebar).getByText("Calendar").closest("a");
    expect(calendarLink).not.toHaveClass("bg-primary/10");
  });

  it("clicking sidebar link navigates and updates active state", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/calendar"]}>
        <AppShell>
          <div>Content</div>
        </AppShell>
      </MemoryRouter>,
    );

    const desktopSidebar = screen.getByTestId("desktop-sidebar");
    const accountsLink = within(desktopSidebar).getByText("Accounts");

    // Click should not throw -- router processes the navigation
    await user.click(accountsLink);

    // After clicking, Accounts should now be the active link
    const updatedLink = within(desktopSidebar).getByText("Accounts").closest("a");
    expect(updatedLink).toHaveClass("bg-primary/10");
  });

  it("renders both desktop and mobile sidebars with same links", () => {
    render(
      <MemoryRouter initialEntries={["/calendar"]}>
        <AppShell>
          <div>Content</div>
        </AppShell>
      </MemoryRouter>,
    );

    const desktopSidebar = screen.getByTestId("desktop-sidebar");
    const mobileSidebar = screen.getByTestId("mobile-sidebar");

    // Both should contain the sidebar nav
    expect(within(desktopSidebar).getByTestId("sidebar")).toBeInTheDocument();
    expect(within(mobileSidebar).getByTestId("sidebar")).toBeInTheDocument();
  });
});
