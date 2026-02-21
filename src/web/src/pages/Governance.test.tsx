/**
 * Tests for the Governance Dashboard page.
 *
 * Covers:
 * - Unit: chart data transformation, VIP list rendering, time allocation
 *   aggregation per week/month
 * - Integration: component renders with mock commitment data, chart shows
 *   actual vs target. VIP list add/remove calls API. Export proof button
 *   calls API and shows download link.
 *
 * Uses React Testing Library with fireEvent for click interactions.
 *
 * Since Governance now uses useApi() internally, tests mock the
 * api-provider and auth modules instead of passing props.
 *
 * NOTE: We use fireEvent.click instead of userEvent.click because components
 * with timers interact poorly with userEvent's internal delay mechanism
 * under fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { Governance } from "./Governance";
import type {
  Commitment,
  VipContact,
  AddVipPayload,
  ExportProofResponse,
} from "../lib/governance";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_COMMITMENTS: Commitment[] = [
  {
    commitment_id: "cmt_1",
    client_name: "Acme Corp",
    target_hours: 40,
    actual_hours: 38,
    period_start: "2026-02-10",
    period_end: "2026-02-16",
  },
  {
    commitment_id: "cmt_2",
    client_name: "Globex Inc",
    target_hours: 20,
    actual_hours: 12,
    period_start: "2026-02-10",
    period_end: "2026-02-16",
  },
  {
    commitment_id: "cmt_3",
    client_name: "Initech",
    target_hours: 10,
    actual_hours: 15,
    period_start: "2026-02-10",
    period_end: "2026-02-16",
  },
];

const MOCK_VIPS: VipContact[] = [
  {
    vip_id: "vip_1",
    name: "Jane CEO",
    email: "jane@acme.com",
    notes: "Quarterly reviews",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    vip_id: "vip_2",
    name: "Bob CTO",
    email: "bob@globex.com",
    notes: "",
    created_at: "2026-01-15T00:00:00Z",
  },
];

const MOCK_NEW_VIP: VipContact = {
  vip_id: "vip_3",
  name: "Alice PM",
  email: "alice@initech.com",
  notes: "Project lead",
  created_at: "2026-02-15T00:00:00Z",
};

const MOCK_EXPORT_RESPONSE: ExportProofResponse = {
  download_url: "https://storage.example.com/proof-cmt_1.pdf",
  filename: "proof-cmt_1.pdf",
  generated_at: "2026-02-15T12:00:00Z",
};

// ---------------------------------------------------------------------------
// Mock the API provider and auth
// ---------------------------------------------------------------------------

const mockFetchCommitments = vi.fn<() => Promise<Commitment[]>>();
const mockFetchVips = vi.fn<() => Promise<VipContact[]>>();
const mockAddVip = vi.fn<(payload: AddVipPayload) => Promise<VipContact>>();
const mockRemoveVip = vi.fn<(vipId: string) => Promise<void>>();
const mockExportProof = vi.fn<(commitmentId: string) => Promise<ExportProofResponse>>();

const mockApiValue = {
  fetchCommitments: mockFetchCommitments,
  fetchVips: mockFetchVips,
  addVip: mockAddVip,
  removeVip: mockRemoveVip,
  exportProof: mockExportProof,
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
  commitments?: Commitment[];
  commitmentsError?: string;
  vips?: VipContact[];
  addVipResult?: VipContact;
  addVipError?: string;
  removeVipError?: string;
  exportResult?: ExportProofResponse;
  exportError?: string;
} = {}) {
  if (overrides.commitmentsError) {
    mockFetchCommitments.mockRejectedValue(new Error(overrides.commitmentsError));
  } else {
    mockFetchCommitments.mockResolvedValue(overrides.commitments ?? MOCK_COMMITMENTS);
  }

  mockFetchVips.mockResolvedValue(overrides.vips ?? MOCK_VIPS);

  if (overrides.addVipError) {
    mockAddVip.mockRejectedValue(new Error(overrides.addVipError));
  } else {
    mockAddVip.mockResolvedValue(overrides.addVipResult ?? MOCK_NEW_VIP);
  }

  if (overrides.removeVipError) {
    mockRemoveVip.mockRejectedValue(new Error(overrides.removeVipError));
  } else {
    mockRemoveVip.mockResolvedValue(undefined);
  }

  if (overrides.exportError) {
    mockExportProof.mockRejectedValue(new Error(overrides.exportError));
  } else {
    mockExportProof.mockResolvedValue(overrides.exportResult ?? MOCK_EXPORT_RESPONSE);
  }
}

/**
 * Render the Governance component and wait for the initial async fetch to resolve.
 */
async function renderAndWait(overrides: {
  commitments?: Commitment[];
  commitmentsError?: string;
  vips?: VipContact[];
  addVipResult?: VipContact;
  addVipError?: string;
  removeVipError?: string;
  exportResult?: ExportProofResponse;
  exportError?: string;
} = {}) {
  setupMocks(overrides);

  const result = render(<Governance />);

  // Flush microtasks so async fetch resolves
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Governance Dashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-02-15T12:00:00Z").getTime() });
    mockFetchCommitments.mockReset();
    mockFetchVips.mockReset();
    mockAddVip.mockReset();
    mockRemoveVip.mockReset();
    mockExportProof.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Unit: Chart Data Transformation (AC#1)
  // =========================================================================

  describe("chart data transformation (AC#1)", () => {
    it("renders a chart row for each commitment", async () => {
      await renderAndWait();

      expect(screen.getByTestId("chart-row-Acme Corp")).toBeInTheDocument();
      expect(screen.getByTestId("chart-row-Globex Inc")).toBeInTheDocument();
      expect(screen.getByTestId("chart-row-Initech")).toBeInTheDocument();
    });

    it("shows target and actual hours per client", async () => {
      await renderAndWait();

      const acmeRow = screen.getByTestId("chart-row-Acme Corp");
      expect(within(acmeRow).getByText(/Target: 40h/)).toBeInTheDocument();
      expect(within(acmeRow).getByText(/Actual: 38h/)).toBeInTheDocument();
    });

    it("shows target and actual bars", async () => {
      await renderAndWait();

      expect(screen.getByTestId("target-bar-Acme Corp")).toBeInTheDocument();
      expect(screen.getByTestId("actual-bar-Acme Corp")).toBeInTheDocument();
    });

    it("shows empty state when no commitments exist", async () => {
      await renderAndWait({ commitments: [] });

      expect(screen.getByTestId("chart-empty")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Unit: Compliance Color Coding (AC#5)
  // =========================================================================

  describe("compliance color coding (AC#5)", () => {
    it("shows compliant (green) badge for on-track commitment", async () => {
      await renderAndWait();

      const badge = screen.getByTestId("compliance-badge-Acme Corp");
      expect(badge).toHaveTextContent("On Track");
      // Green color for compliant
      expect(badge.style.color).toBe("rgb(34, 197, 94)");
    });

    it("shows under (yellow) badge for under-target commitment", async () => {
      await renderAndWait();

      const badge = screen.getByTestId("compliance-badge-Globex Inc");
      expect(badge).toHaveTextContent("Under Target");
      // Yellow color for under
      expect(badge.style.color).toBe("rgb(234, 179, 8)");
    });

    it("shows over (blue) badge for over-target commitment", async () => {
      await renderAndWait();

      const badge = screen.getByTestId("compliance-badge-Initech");
      expect(badge).toHaveTextContent("Over Target");
      // Blue color for over
      expect(badge.style.color).toBe("rgb(59, 130, 246)");
    });
  });

  // =========================================================================
  // Unit: VIP List Rendering (AC#2)
  // =========================================================================

  describe("VIP list rendering (AC#2)", () => {
    it("renders VIP contacts from API", async () => {
      await renderAndWait();

      expect(screen.getByTestId("vip-row-vip_1")).toBeInTheDocument();
      expect(screen.getByTestId("vip-row-vip_2")).toBeInTheDocument();
    });

    it("shows VIP name and email", async () => {
      await renderAndWait();

      const row1 = screen.getByTestId("vip-row-vip_1");
      expect(within(row1).getByText("Jane CEO")).toBeInTheDocument();
      expect(within(row1).getByText("jane@acme.com")).toBeInTheDocument();
    });

    it("shows VIP notes when present", async () => {
      await renderAndWait();

      const row1 = screen.getByTestId("vip-row-vip_1");
      expect(within(row1).getByText("Quarterly reviews")).toBeInTheDocument();
    });

    it("shows remove button for each VIP", async () => {
      await renderAndWait();

      expect(screen.getByTestId("remove-vip-btn-vip_1")).toBeInTheDocument();
      expect(screen.getByTestId("remove-vip-btn-vip_2")).toBeInTheDocument();
    });

    it("shows empty state when no VIPs exist", async () => {
      await renderAndWait({ vips: [] });

      expect(screen.getByTestId("vip-empty")).toBeInTheDocument();
    });

    it("shows add VIP form with name, email, notes fields", async () => {
      await renderAndWait();

      expect(screen.getByTestId("vip-name-input")).toBeInTheDocument();
      expect(screen.getByTestId("vip-email-input")).toBeInTheDocument();
      expect(screen.getByTestId("vip-notes-input")).toBeInTheDocument();
      expect(screen.getByTestId("add-vip-btn")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Unit: Time Allocation View (AC#3)
  // =========================================================================

  describe("time allocation view (AC#3)", () => {
    it("renders weekly view by default", async () => {
      await renderAndWait();

      expect(screen.getByTestId("time-allocation-section")).toBeInTheDocument();
      expect(screen.getByTestId("view-weekly-btn")).toBeInTheDocument();
      expect(screen.getByTestId("view-monthly-btn")).toBeInTheDocument();
    });

    it("shows time allocation periods with totals", async () => {
      await renderAndWait();

      const periodsContainer = screen.getByTestId("allocation-periods");
      expect(periodsContainer).toBeInTheDocument();

      // Should show total hours: 38 + 12 + 15 = 65
      const totalElements = screen.getAllByText(/Total: 65h/);
      expect(totalElements.length).toBeGreaterThan(0);
    });

    it("shows per-client hours in allocation", async () => {
      await renderAndWait();

      const allocationSection = screen.getByTestId("time-allocation-section");
      expect(within(allocationSection).getByText("Acme Corp")).toBeInTheDocument();
      expect(within(allocationSection).getByText("Globex Inc")).toBeInTheDocument();
      expect(within(allocationSection).getByText("Initech")).toBeInTheDocument();
    });

    it("switches to monthly view on button click", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("view-monthly-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Should still show allocation data (same data, different grouping)
      expect(screen.getByTestId("allocation-periods")).toBeInTheDocument();
    });

    it("shows empty state when no allocations exist", async () => {
      await renderAndWait({ commitments: [] });

      expect(screen.getByTestId("allocation-empty")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration: Component Renders with Mock Data
  // =========================================================================

  describe("integration: component loads data on mount", () => {
    it("calls fetchCommitments on mount", async () => {
      await renderAndWait();

      expect(mockFetchCommitments).toHaveBeenCalledTimes(1);
    });

    it("calls fetchVips on mount", async () => {
      await renderAndWait();

      expect(mockFetchVips).toHaveBeenCalledTimes(1);
    });

    it("shows loading state before fetch completes", () => {
      mockFetchCommitments.mockReturnValue(new Promise(() => {}));
      mockFetchVips.mockReturnValue(new Promise(() => {}));

      render(<Governance />);

      expect(screen.getByTestId("governance-loading")).toBeInTheDocument();
    });

    it("shows error state when fetchCommitments fails", async () => {
      await renderAndWait({ commitmentsError: "API unavailable" });

      expect(screen.getByTestId("governance-error")).toBeInTheDocument();
      expect(screen.getByText(/api unavailable/i)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      await renderAndWait({ commitmentsError: "Network error" });

      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    it("chart shows actual vs target bars with correct data", async () => {
      await renderAndWait();

      const complianceChart = screen.getByTestId("compliance-chart");
      expect(complianceChart).toBeInTheDocument();

      // Acme Corp: target 40h, actual 38h
      const acmeRow = screen.getByTestId("chart-row-Acme Corp");
      expect(within(acmeRow).getByText(/Target: 40h/)).toBeInTheDocument();
      expect(within(acmeRow).getByText(/Actual: 38h/)).toBeInTheDocument();

      // Globex Inc: target 20h, actual 12h
      const globexRow = screen.getByTestId("chart-row-Globex Inc");
      expect(within(globexRow).getByText(/Target: 20h/)).toBeInTheDocument();
      expect(within(globexRow).getByText(/Actual: 12h/)).toBeInTheDocument();

      // Initech: target 10h, actual 15h
      const initechRow = screen.getByTestId("chart-row-Initech");
      expect(within(initechRow).getByText(/Target: 10h/)).toBeInTheDocument();
      expect(within(initechRow).getByText(/Actual: 15h/)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration: VIP Add/Remove Calls API (AC#2)
  // =========================================================================

  describe("integration: VIP add/remove calls API", () => {
    it("clicking add VIP calls addVip with form data", async () => {
      await renderAndWait();

      // Fill form
      fireEvent.change(screen.getByTestId("vip-name-input"), {
        target: { value: "Alice PM" },
      });
      fireEvent.change(screen.getByTestId("vip-email-input"), {
        target: { value: "alice@initech.com" },
      });
      fireEvent.change(screen.getByTestId("vip-notes-input"), {
        target: { value: "Project lead" },
      });

      // Submit
      fireEvent.click(screen.getByTestId("add-vip-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockAddVip).toHaveBeenCalledTimes(1);
      expect(mockAddVip).toHaveBeenCalledWith({
        name: "Alice PM",
        email: "alice@initech.com",
        notes: "Project lead",
      });
    });

    it("shows success message after adding VIP", async () => {
      await renderAndWait();

      fireEvent.change(screen.getByTestId("vip-name-input"), {
        target: { value: "Alice" },
      });
      fireEvent.change(screen.getByTestId("vip-email-input"), {
        target: { value: "alice@test.com" },
      });

      fireEvent.click(screen.getByTestId("add-vip-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("governance-status-msg")).toBeInTheDocument();
      expect(screen.getByTestId("governance-status-msg")).toHaveTextContent(/vip contact added/i);
    });

    it("shows error message when addVip fails", async () => {
      await renderAndWait({ addVipError: "Duplicate email" });

      fireEvent.change(screen.getByTestId("vip-name-input"), {
        target: { value: "Test" },
      });
      fireEvent.change(screen.getByTestId("vip-email-input"), {
        target: { value: "test@test.com" },
      });

      fireEvent.click(screen.getByTestId("add-vip-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const statusMsg = screen.getByTestId("governance-status-msg");
      expect(statusMsg).toHaveTextContent(/duplicate email/i);
    });

    it("clears form after successful VIP add", async () => {
      await renderAndWait();

      fireEvent.change(screen.getByTestId("vip-name-input"), {
        target: { value: "Alice" },
      });
      fireEvent.change(screen.getByTestId("vip-email-input"), {
        target: { value: "alice@test.com" },
      });
      fireEvent.change(screen.getByTestId("vip-notes-input"), {
        target: { value: "Notes" },
      });

      fireEvent.click(screen.getByTestId("add-vip-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("vip-name-input")).toHaveValue("");
      expect(screen.getByTestId("vip-email-input")).toHaveValue("");
      expect(screen.getByTestId("vip-notes-input")).toHaveValue("");
    });

    it("refreshes VIP list after adding", async () => {
      await renderAndWait();

      expect(mockFetchVips).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByTestId("vip-name-input"), {
        target: { value: "Test" },
      });
      fireEvent.change(screen.getByTestId("vip-email-input"), {
        target: { value: "test@test.com" },
      });

      fireEvent.click(screen.getByTestId("add-vip-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetchVips).toHaveBeenCalledTimes(2);
    });

    it("clicking remove VIP calls removeVip with VIP ID", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("remove-vip-btn-vip_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockRemoveVip).toHaveBeenCalledTimes(1);
      expect(mockRemoveVip).toHaveBeenCalledWith("vip_1");
    });

    it("shows success message after removing VIP", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("remove-vip-btn-vip_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("governance-status-msg")).toHaveTextContent(/vip contact removed/i);
    });

    it("shows error message when removeVip fails", async () => {
      await renderAndWait({ removeVipError: "Permission denied" });

      fireEvent.click(screen.getByTestId("remove-vip-btn-vip_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const statusMsg = screen.getByTestId("governance-status-msg");
      expect(statusMsg).toHaveTextContent(/permission denied/i);
    });

    it("refreshes VIP list after removing", async () => {
      await renderAndWait();

      expect(mockFetchVips).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId("remove-vip-btn-vip_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetchVips).toHaveBeenCalledTimes(2);
    });

    it("disables add button when name is empty", async () => {
      await renderAndWait();

      fireEvent.change(screen.getByTestId("vip-email-input"), {
        target: { value: "test@test.com" },
      });

      const addBtn = screen.getByTestId("add-vip-btn");
      expect(addBtn).toBeDisabled();
    });

    it("disables add button when email is empty", async () => {
      await renderAndWait();

      fireEvent.change(screen.getByTestId("vip-name-input"), {
        target: { value: "Test Name" },
      });

      const addBtn = screen.getByTestId("add-vip-btn");
      expect(addBtn).toBeDisabled();
    });
  });

  // =========================================================================
  // Integration: Export Proof (AC#4)
  // =========================================================================

  describe("integration: export proof button calls API", () => {
    it("renders export button per commitment", async () => {
      await renderAndWait();

      expect(screen.getByTestId("export-btn-cmt_1")).toBeInTheDocument();
      expect(screen.getByTestId("export-btn-cmt_2")).toBeInTheDocument();
      expect(screen.getByTestId("export-btn-cmt_3")).toBeInTheDocument();
    });

    it("clicking export calls exportProof with commitment ID", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("export-btn-cmt_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockExportProof).toHaveBeenCalledTimes(1);
      expect(mockExportProof).toHaveBeenCalledWith("cmt_1");
    });

    it("shows download link after successful export", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("export-btn-cmt_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const downloadLink = screen.getByTestId("download-link-cmt_1");
      expect(downloadLink).toBeInTheDocument();
      expect(downloadLink).toHaveAttribute("href", "https://storage.example.com/proof-cmt_1.pdf");
      expect(downloadLink).toHaveTextContent("proof-cmt_1.pdf");
    });

    it("shows success message after export", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("export-btn-cmt_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("governance-status-msg")).toHaveTextContent(/export proof generated/i);
    });

    it("shows error message when export fails", async () => {
      await renderAndWait({ exportError: "Export service unavailable" });

      fireEvent.click(screen.getByTestId("export-btn-cmt_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const statusMsg = screen.getByTestId("governance-status-msg");
      expect(statusMsg).toHaveTextContent(/export service unavailable/i);
    });

    it("shows Exporting... while export is in progress", async () => {
      // Create a slow export that we can control
      let resolveExport: (value: ExportProofResponse) => void;
      setupMocks();
      mockExportProof.mockImplementation(
        () =>
          new Promise<ExportProofResponse>((resolve) => {
            resolveExport = resolve;
          }),
      );

      render(<Governance />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("export-btn-cmt_1"));

      // The button should show "Exporting..." immediately
      expect(screen.getByTestId("export-btn-cmt_1")).toHaveTextContent("Exporting...");

      // Resolve the export
      await act(async () => {
        resolveExport!(MOCK_EXPORT_RESPONSE);
        await vi.advanceTimersByTimeAsync(0);
      });

      // The button should return to normal
      expect(screen.getByTestId("export-btn-cmt_1")).toHaveTextContent("Export Proof");
    });
  });

  // =========================================================================
  // Responsive Design / Structure
  // =========================================================================

  describe("page structure", () => {
    it("renders all major sections", async () => {
      await renderAndWait();

      // Title
      expect(screen.getByText("Governance Dashboard")).toBeInTheDocument();
      // Back link
      expect(screen.getByText("Back to Calendar")).toBeInTheDocument();
      // Chart section
      expect(screen.getByTestId("compliance-chart")).toBeInTheDocument();
      // VIP section
      expect(screen.getByTestId("vip-section")).toBeInTheDocument();
      // Time allocation section
      expect(screen.getByTestId("time-allocation-section")).toBeInTheDocument();
    });

    it("renders section titles", async () => {
      await renderAndWait();

      expect(screen.getByText("Commitment Compliance")).toBeInTheDocument();
      expect(screen.getByText("VIP Contacts")).toBeInTheDocument();
      expect(screen.getByText("Time Allocation")).toBeInTheDocument();
    });
  });
});
