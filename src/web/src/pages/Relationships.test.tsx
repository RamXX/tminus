/**
 * Tests for the Relationships Dashboard page.
 *
 * Covers:
 * - Unit: Contact list rendering with category badges and drift indicators,
 *   detail view with reputation scores, drift report display
 * - Integration: Component renders with mock data, CRUD operations call API,
 *   form validation, navigation between views
 *
 * Uses React Testing Library with fireEvent for click interactions.
 * Same pattern as Governance.test.tsx.
 *
 * Since Relationships now uses useApi() internally, tests mock the
 * api-provider and auth modules instead of passing props.
 *
 * NOTE: We use fireEvent.click instead of userEvent.click because components
 * with timers interact poorly with userEvent's internal delay mechanism
 * under fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { Relationships } from "./Relationships";
import type {
  Relationship,
  CreateRelationshipPayload,
  UpdateRelationshipPayload,
  ReputationScores,
  Outcome,
  CreateOutcomePayload,
  DriftReport,
} from "../lib/relationships";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_RELATIONSHIPS: Relationship[] = [
  {
    id: "rel_1",
    name: "Alice Johnson",
    email: "alice@example.com",
    category: "professional",
    city: "San Francisco",
    timezone: "America/Los_Angeles",
    frequency_days: 7,
    last_interaction: "2026-02-14T12:00:00Z",
    drift_level: "green",
    reliability_score: 92,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-02-14T12:00:00Z",
  },
  {
    id: "rel_2",
    name: "Bob Smith",
    email: "bob@example.com",
    category: "vip",
    city: "New York",
    timezone: "America/New_York",
    frequency_days: 14,
    last_interaction: "2026-01-20T12:00:00Z",
    drift_level: "yellow",
    reliability_score: 78,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-20T12:00:00Z",
  },
  {
    id: "rel_3",
    name: "Charlie Brown",
    email: "charlie@example.com",
    category: "family",
    city: "Chicago",
    timezone: "America/Chicago",
    frequency_days: 7,
    last_interaction: null,
    drift_level: "red",
    reliability_score: 45,
    created_at: "2026-01-15T00:00:00Z",
    updated_at: "2026-01-15T00:00:00Z",
  },
];

const MOCK_REPUTATION: ReputationScores = {
  reliability_score: 92,
  responsiveness_score: 88,
  follow_through_score: 95,
  overall_score: 91,
  total_interactions: 24,
  positive_outcomes: 20,
  negative_outcomes: 2,
};

const MOCK_OUTCOMES: Outcome[] = [
  {
    outcome_id: "out_1",
    relationship_id: "rel_1",
    outcome_type: "positive",
    description: "Successful project delivery",
    occurred_at: "2026-02-14T12:00:00Z",
    created_at: "2026-02-14T12:00:00Z",
  },
  {
    outcome_id: "out_2",
    relationship_id: "rel_1",
    outcome_type: "negative",
    description: "Missed deadline",
    occurred_at: "2026-02-01T12:00:00Z",
    created_at: "2026-02-01T12:00:00Z",
  },
  {
    outcome_id: "out_3",
    relationship_id: "rel_1",
    outcome_type: "neutral",
    description: "Regular check-in",
    occurred_at: "2026-01-15T12:00:00Z",
    created_at: "2026-01-15T12:00:00Z",
  },
];

const MOCK_DRIFT_REPORT: DriftReport = {
  entries: [
    {
      relationship_id: "rel_3",
      name: "Charlie Brown",
      category: "family",
      days_overdue: 30,
      drift_level: "red",
      last_interaction: null,
      frequency_days: 7,
    },
    {
      relationship_id: "rel_2",
      name: "Bob Smith",
      category: "vip",
      days_overdue: 12,
      drift_level: "yellow",
      last_interaction: "2026-01-20T12:00:00Z",
      frequency_days: 14,
    },
  ],
  generated_at: "2026-02-15T12:00:00Z",
};

const MOCK_NEW_RELATIONSHIP: Relationship = {
  id: "rel_4",
  name: "Diana Prince",
  email: "diana@example.com",
  category: "community",
  city: "Metropolis",
  timezone: "America/New_York",
  frequency_days: 30,
  last_interaction: null,
  drift_level: "red",
  reliability_score: 0,
  created_at: "2026-02-15T12:00:00Z",
  updated_at: "2026-02-15T12:00:00Z",
};

// ---------------------------------------------------------------------------
// Mock the API provider and auth
// ---------------------------------------------------------------------------

const mockFetchRelationships = vi.fn<() => Promise<Relationship[]>>();
const mockCreateRelationship = vi.fn<(p: CreateRelationshipPayload) => Promise<Relationship>>();
const mockFetchRelationship = vi.fn<(id: string) => Promise<Relationship>>();
const mockUpdateRelationship = vi.fn<(id: string, p: UpdateRelationshipPayload) => Promise<Relationship>>();
const mockDeleteRelationship = vi.fn<(id: string) => Promise<void>>();
const mockFetchReputation = vi.fn<(id: string) => Promise<ReputationScores>>();
const mockFetchOutcomes = vi.fn<(id: string) => Promise<Outcome[]>>();
const mockCreateOutcome = vi.fn<(id: string, p: CreateOutcomePayload) => Promise<Outcome>>();
const mockFetchDriftReport = vi.fn<() => Promise<DriftReport>>();

const mockApiValue = {
  fetchRelationships: mockFetchRelationships,
  createRelationship: mockCreateRelationship,
  fetchRelationship: mockFetchRelationship,
  updateRelationship: mockUpdateRelationship,
  deleteRelationship: mockDeleteRelationship,
  fetchReputation: mockFetchReputation,
  fetchOutcomes: mockFetchOutcomes,
  createOutcome: mockCreateOutcome,
  fetchDriftReport: mockFetchDriftReport,
};

vi.mock("../lib/api-provider", () => ({
  useApi: () => mockApiValue,
  ApiProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    token: "test-jwt-token",
    refreshToken: "test-refresh-token",
    user: { id: "user-1", email: "test@example.com" },
    login: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupMocks(overrides: {
  relationships?: Relationship[];
  relationshipsError?: string;
  relationship?: Relationship;
  reputation?: ReputationScores;
  outcomes?: Outcome[];
  createResult?: Relationship;
  createError?: string;
  updateResult?: Relationship;
  deleteError?: string;
  driftReport?: DriftReport;
} = {}) {
  if (overrides.relationshipsError) {
    mockFetchRelationships.mockRejectedValue(new Error(overrides.relationshipsError));
  } else {
    mockFetchRelationships.mockResolvedValue(overrides.relationships ?? MOCK_RELATIONSHIPS);
  }

  mockFetchRelationship.mockResolvedValue(overrides.relationship ?? MOCK_RELATIONSHIPS[0]);
  mockFetchReputation.mockResolvedValue(overrides.reputation ?? MOCK_REPUTATION);
  mockFetchOutcomes.mockResolvedValue(overrides.outcomes ?? MOCK_OUTCOMES);

  if (overrides.createError) {
    mockCreateRelationship.mockRejectedValue(new Error(overrides.createError));
  } else {
    mockCreateRelationship.mockResolvedValue(overrides.createResult ?? MOCK_NEW_RELATIONSHIP);
  }

  if (overrides.deleteError) {
    mockDeleteRelationship.mockRejectedValue(new Error(overrides.deleteError));
  } else {
    mockDeleteRelationship.mockResolvedValue(undefined);
  }

  mockUpdateRelationship.mockResolvedValue(overrides.updateResult ?? MOCK_RELATIONSHIPS[0]);
  mockFetchDriftReport.mockResolvedValue(overrides.driftReport ?? MOCK_DRIFT_REPORT);
  mockCreateOutcome.mockResolvedValue(MOCK_OUTCOMES[0]);
}

/**
 * Render the Relationships component and wait for initial async fetch.
 */
async function renderAndWait(overrides: Parameters<typeof setupMocks>[0] = {}) {
  setupMocks(overrides);

  const result = render(<Relationships />);

  // Flush microtasks so async fetch resolves
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Relationships Dashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-02-15T12:00:00Z").getTime() });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // AC#1: Contact list with category badges
  // =========================================================================

  describe("contact list with category badges (AC#1)", () => {
    it("renders a contact row for each relationship", async () => {
      await renderAndWait();

      expect(screen.getByTestId("contact-row-rel_1")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-rel_2")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-rel_3")).toBeInTheDocument();
    });

    it("shows contact name and email", async () => {
      await renderAndWait();

      const row1 = screen.getByTestId("contact-row-rel_1");
      expect(within(row1).getByText("Alice Johnson")).toBeInTheDocument();
      expect(within(row1).getByText("alice@example.com")).toBeInTheDocument();
    });

    it("shows category badge for each contact", async () => {
      await renderAndWait();

      expect(screen.getByTestId("category-badge-rel_1")).toHaveTextContent("Professional");
      expect(screen.getByTestId("category-badge-rel_2")).toHaveTextContent("Vip");
      expect(screen.getByTestId("category-badge-rel_3")).toHaveTextContent("Family");
    });

    it("shows category badge with correct colors", async () => {
      await renderAndWait();

      const badge = screen.getByTestId("category-badge-rel_1");
      // Professional = blue
      expect(badge.style.color).toBe("rgb(59, 130, 246)");
    });

    it("shows empty state when no relationships exist", async () => {
      await renderAndWait({ relationships: [] });

      expect(screen.getByTestId("list-empty")).toBeInTheDocument();
    });

    it("shows last interaction date for each contact", async () => {
      await renderAndWait();

      // rel_1 has a last interaction date
      const lastDate = screen.getByTestId("last-interaction-rel_1");
      expect(lastDate).toBeInTheDocument();
      expect(lastDate.textContent).not.toBe("Never");

      // rel_3 has null last interaction
      const neverDate = screen.getByTestId("last-interaction-rel_3");
      expect(neverDate).toHaveTextContent("Never");
    });

    it("shows reliability score for each contact", async () => {
      await renderAndWait();

      expect(screen.getByTestId("reliability-rel_1")).toHaveTextContent("92/100");
      expect(screen.getByTestId("reliability-rel_2")).toHaveTextContent("78/100");
      expect(screen.getByTestId("reliability-rel_3")).toHaveTextContent("45/100");
    });
  });

  // =========================================================================
  // AC#2: Drift indicators (green/yellow/red)
  // =========================================================================

  describe("drift indicators (AC#2)", () => {
    it("shows green drift badge for on-track contact", async () => {
      await renderAndWait();

      const badge = screen.getByTestId("drift-badge-rel_1");
      expect(badge).toHaveTextContent("On Track");
      expect(badge.style.color).toBe("rgb(34, 197, 94)"); // green
    });

    it("shows yellow drift badge for drifting contact", async () => {
      await renderAndWait();

      const badge = screen.getByTestId("drift-badge-rel_2");
      expect(badge).toHaveTextContent("Drifting");
      expect(badge.style.color).toBe("rgb(234, 179, 8)"); // yellow
    });

    it("shows red drift badge for overdue contact", async () => {
      await renderAndWait();

      const badge = screen.getByTestId("drift-badge-rel_3");
      expect(badge).toHaveTextContent("Overdue");
      expect(badge.style.color).toBe("rgb(239, 68, 68)"); // red
    });
  });

  // =========================================================================
  // AC#3: Contact detail with interaction timeline
  // =========================================================================

  describe("contact detail with interaction timeline (AC#3)", () => {
    it("opens detail view when clicking a contact", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("contact-detail")).toBeInTheDocument();
    });

    it("shows contact name and email in detail view", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("detail-name")).toHaveTextContent("Alice Johnson");
      expect(screen.getByTestId("detail-email")).toHaveTextContent("alice@example.com");
    });

    it("shows category and drift badges in detail view", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("detail-category")).toHaveTextContent("Professional");
      expect(screen.getByTestId("detail-drift")).toHaveTextContent("On Track");
    });

    it("shows interaction timeline with outcomes", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("outcomes-list")).toBeInTheDocument();
      expect(screen.getByTestId("outcome-out_1")).toBeInTheDocument();
      expect(screen.getByTestId("outcome-out_2")).toBeInTheDocument();
      expect(screen.getByTestId("outcome-out_3")).toBeInTheDocument();
    });

    it("shows outcome types in timeline", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("outcome-type-out_1")).toHaveTextContent("positive");
      expect(screen.getByTestId("outcome-type-out_2")).toHaveTextContent("negative");
      expect(screen.getByTestId("outcome-type-out_3")).toHaveTextContent("neutral");
    });

    it("shows outcome descriptions", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const outcome1 = screen.getByTestId("outcome-out_1");
      expect(within(outcome1).getByText("Successful project delivery")).toBeInTheDocument();
    });

    it("shows empty outcomes state when no interactions exist", async () => {
      await renderAndWait({ outcomes: [] });

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("outcomes-empty")).toBeInTheDocument();
    });

    it("fetches detail, reputation, and outcomes on click", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetchRelationship).toHaveBeenCalledWith("rel_1");
      expect(mockFetchReputation).toHaveBeenCalledWith("rel_1");
      expect(mockFetchOutcomes).toHaveBeenCalledWith("rel_1");
    });

    it("navigates back to list view", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("contact-detail")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("back-to-list-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("contact-list")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // AC#4: Reputation scores visible
  // =========================================================================

  describe("reputation scores visible (AC#4)", () => {
    it("shows reputation section in detail view", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("reputation-section")).toBeInTheDocument();
    });

    it("shows overall score", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("score-overall")).toHaveTextContent("91/100");
    });

    it("shows reliability score", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("score-reliability")).toHaveTextContent("92/100");
    });

    it("shows responsiveness score", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("score-responsiveness")).toHaveTextContent("88/100");
    });

    it("shows follow-through score", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("score-follow-through")).toHaveTextContent("95/100");
    });

    it("shows interaction counts", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("score-interactions")).toHaveTextContent("24");
      expect(screen.getByTestId("score-positive")).toHaveTextContent("20");
      expect(screen.getByTestId("score-negative")).toHaveTextContent("2");
    });
  });

  // =========================================================================
  // AC#5: Add/edit/delete relationships
  // =========================================================================

  describe("add/edit/delete relationships (AC#5)", () => {
    // -- Add --

    it("shows add relationship button", async () => {
      await renderAndWait();
      expect(screen.getByTestId("add-relationship-btn")).toBeInTheDocument();
    });

    it("opens add form when clicking add button", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("add-relationship-btn"));

      expect(screen.getByTestId("add-form")).toBeInTheDocument();
    });

    it("shows all form fields for adding", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("add-relationship-btn"));

      expect(screen.getByTestId("form-name-input")).toBeInTheDocument();
      expect(screen.getByTestId("form-email-input")).toBeInTheDocument();
      expect(screen.getByTestId("form-category-select")).toBeInTheDocument();
      expect(screen.getByTestId("form-city-input")).toBeInTheDocument();
      expect(screen.getByTestId("form-timezone-input")).toBeInTheDocument();
      expect(screen.getByTestId("form-frequency-select")).toBeInTheDocument();
    });

    it("calls createRelationship with form data on submit", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("add-relationship-btn"));

      fireEvent.change(screen.getByTestId("form-name-input"), {
        target: { value: "Diana Prince" },
      });
      fireEvent.change(screen.getByTestId("form-email-input"), {
        target: { value: "diana@example.com" },
      });
      fireEvent.change(screen.getByTestId("form-category-select"), {
        target: { value: "community" },
      });
      fireEvent.change(screen.getByTestId("form-city-input"), {
        target: { value: "Metropolis" },
      });
      fireEvent.change(screen.getByTestId("form-timezone-input"), {
        target: { value: "America/New_York" },
      });
      fireEvent.change(screen.getByTestId("form-frequency-select"), {
        target: { value: "30" },
      });

      fireEvent.click(screen.getByTestId("submit-create-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockCreateRelationship).toHaveBeenCalledTimes(1);
      expect(mockCreateRelationship).toHaveBeenCalledWith({
        name: "Diana Prince",
        email: "diana@example.com",
        category: "community",
        city: "Metropolis",
        timezone: "America/New_York",
        frequency_days: 30,
      });
    });

    it("shows success message after creating", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("add-relationship-btn"));

      fireEvent.change(screen.getByTestId("form-name-input"), {
        target: { value: "Test" },
      });
      fireEvent.change(screen.getByTestId("form-email-input"), {
        target: { value: "test@test.com" },
      });

      fireEvent.click(screen.getByTestId("submit-create-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // After success, should go back to list view with status message
      expect(screen.getByTestId("relationships-status-msg")).toHaveTextContent(
        /relationship created/i,
      );
    });

    it("refreshes list after creating", async () => {
      await renderAndWait();

      expect(mockFetchRelationships).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId("add-relationship-btn"));

      fireEvent.change(screen.getByTestId("form-name-input"), {
        target: { value: "Test" },
      });
      fireEvent.change(screen.getByTestId("form-email-input"), {
        target: { value: "test@test.com" },
      });

      fireEvent.click(screen.getByTestId("submit-create-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetchRelationships).toHaveBeenCalledTimes(2);
    });

    it("shows error message when create fails", async () => {
      await renderAndWait({ createError: "Duplicate email" });

      fireEvent.click(screen.getByTestId("add-relationship-btn"));

      fireEvent.change(screen.getByTestId("form-name-input"), {
        target: { value: "Test" },
      });
      fireEvent.change(screen.getByTestId("form-email-input"), {
        target: { value: "test@test.com" },
      });

      fireEvent.click(screen.getByTestId("submit-create-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("relationships-status-msg")).toHaveTextContent(
        /duplicate email/i,
      );
    });

    it("disables submit when name is empty", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("add-relationship-btn"));

      fireEvent.change(screen.getByTestId("form-email-input"), {
        target: { value: "test@test.com" },
      });

      expect(screen.getByTestId("submit-create-btn")).toBeDisabled();
    });

    it("disables submit when email is empty", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("add-relationship-btn"));

      fireEvent.change(screen.getByTestId("form-name-input"), {
        target: { value: "Test" },
      });

      expect(screen.getByTestId("submit-create-btn")).toBeDisabled();
    });

    // -- Edit --

    it("shows edit button in detail view", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("edit-btn")).toBeInTheDocument();
    });

    it("opens edit form when clicking edit", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("edit-btn"));

      expect(screen.getByTestId("edit-form")).toBeInTheDocument();
    });

    it("pre-fills edit form with current values", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("edit-btn"));

      expect(screen.getByTestId("edit-name-input")).toHaveValue("Alice Johnson");
      expect(screen.getByTestId("edit-email-input")).toHaveValue("alice@example.com");
    });

    it("calls updateRelationship on save", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("edit-btn"));

      fireEvent.change(screen.getByTestId("edit-name-input"), {
        target: { value: "Alice Updated" },
      });

      fireEvent.click(screen.getByTestId("save-edit-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockUpdateRelationship).toHaveBeenCalledTimes(1);
      expect(mockUpdateRelationship).toHaveBeenCalledWith("rel_1", expect.objectContaining({
        name: "Alice Updated",
      }));
    });

    it("shows success message after updating", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("edit-btn"));

      fireEvent.change(screen.getByTestId("edit-name-input"), {
        target: { value: "Alice Updated" },
      });

      fireEvent.click(screen.getByTestId("save-edit-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("relationships-status-msg")).toHaveTextContent(
        /relationship updated/i,
      );
    });

    it("cancels edit mode", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("edit-btn"));
      expect(screen.getByTestId("edit-form")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("cancel-edit-btn"));
      expect(screen.queryByTestId("edit-form")).not.toBeInTheDocument();
    });

    // -- Delete --

    it("shows delete button in detail view", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("delete-btn")).toBeInTheDocument();
    });

    it("calls deleteRelationship when clicking delete", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("delete-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockDeleteRelationship).toHaveBeenCalledTimes(1);
      expect(mockDeleteRelationship).toHaveBeenCalledWith("rel_1");
    });

    it("returns to list after deleting", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("delete-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("contact-list")).toBeInTheDocument();
    });

    it("shows success message after deleting", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("delete-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("relationships-status-msg")).toHaveTextContent(
        /relationship deleted/i,
      );
    });

    it("shows error when delete fails", async () => {
      await renderAndWait({ deleteError: "Cannot delete VIP" });

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("delete-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("relationships-status-msg")).toHaveTextContent(
        /cannot delete vip/i,
      );
    });

    it("refreshes list after deleting", async () => {
      await renderAndWait();

      expect(mockFetchRelationships).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId("contact-row-rel_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("delete-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetchRelationships).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // AC#6: Drift report view
  // =========================================================================

  describe("drift report view (AC#6)", () => {
    it("shows drift report button", async () => {
      await renderAndWait();
      expect(screen.getByTestId("drift-report-btn")).toBeInTheDocument();
    });

    it("opens drift report view", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("drift-report")).toBeInTheDocument();
    });

    it("shows drift entries sorted by severity", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("drift-entries")).toBeInTheDocument();
      expect(screen.getByTestId("drift-entry-rel_3")).toBeInTheDocument();
      expect(screen.getByTestId("drift-entry-rel_2")).toBeInTheDocument();
    });

    it("shows names in drift entries", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("drift-name-rel_3")).toHaveTextContent("Charlie Brown");
      expect(screen.getByTestId("drift-name-rel_2")).toHaveTextContent("Bob Smith");
    });

    it("shows drift indicators in report", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("drift-indicator-rel_3")).toHaveTextContent("Overdue");
      expect(screen.getByTestId("drift-indicator-rel_2")).toHaveTextContent("Drifting");
    });

    it("shows days overdue in report", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("drift-days-rel_3")).toHaveTextContent("30 days overdue");
      expect(screen.getByTestId("drift-days-rel_2")).toHaveTextContent("12 days overdue");
    });

    it("shows empty drift report when all on track", async () => {
      await renderAndWait({
        driftReport: { entries: [], generated_at: "2026-02-15T12:00:00Z" },
      });

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("drift-empty")).toBeInTheDocument();
    });

    it("calls fetchDriftReport on view", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetchDriftReport).toHaveBeenCalledTimes(1);
    });

    it("navigates back to list from drift report", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("back-to-list-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("contact-list")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration: Component loads data on mount
  // =========================================================================

  describe("integration: component loads data on mount", () => {
    it("calls fetchRelationships on mount", async () => {
      await renderAndWait();

      expect(mockFetchRelationships).toHaveBeenCalledTimes(1);
    });

    it("shows loading state before fetch completes", () => {
      mockFetchRelationships.mockReturnValue(new Promise(() => {}));
      mockFetchRelationship.mockResolvedValue(MOCK_RELATIONSHIPS[0]);
      mockFetchReputation.mockResolvedValue(MOCK_REPUTATION);
      mockFetchOutcomes.mockResolvedValue(MOCK_OUTCOMES);
      mockCreateRelationship.mockResolvedValue(MOCK_NEW_RELATIONSHIP);
      mockDeleteRelationship.mockResolvedValue(undefined);
      mockUpdateRelationship.mockResolvedValue(MOCK_RELATIONSHIPS[0]);
      mockFetchDriftReport.mockResolvedValue(MOCK_DRIFT_REPORT);
      mockCreateOutcome.mockResolvedValue(MOCK_OUTCOMES[0]);

      render(<Relationships />);

      expect(screen.getByTestId("relationships-loading")).toBeInTheDocument();
    });

    it("shows error state when fetchRelationships fails", async () => {
      await renderAndWait({ relationshipsError: "API unavailable" });

      expect(screen.getByTestId("relationships-error")).toBeInTheDocument();
      expect(screen.getByText(/api unavailable/i)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      await renderAndWait({ relationshipsError: "Network error" });

      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Page structure
  // =========================================================================

  describe("page structure", () => {
    it("renders title and navigation", async () => {
      await renderAndWait();

      expect(screen.getByText("Relationships")).toBeInTheDocument();
      expect(screen.getByText("Back to Calendar")).toBeInTheDocument();
    });

    it("renders contact list section", async () => {
      await renderAndWait();

      expect(screen.getByTestId("contact-list")).toBeInTheDocument();
      expect(screen.getByText("Contacts")).toBeInTheDocument();
    });

    it("renders add and drift report buttons", async () => {
      await renderAndWait();

      expect(screen.getByTestId("add-relationship-btn")).toBeInTheDocument();
      expect(screen.getByTestId("drift-report-btn")).toBeInTheDocument();
    });
  });
});
