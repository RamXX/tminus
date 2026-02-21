/**
 * Login page integration tests.
 *
 * Verifies the Login component renders correctly with Tailwind design-system
 * classes after the inline-to-Tailwind conversion. These are integration tests
 * because they render the REAL component tree (Login + AuthProvider) against
 * a real jsdom DOM -- no rendering infrastructure is mocked.
 *
 * The only mock is `apiLogin` from lib/api, which is an external system
 * boundary (network call to POST /api/v1/auth/login). This is acceptable
 * per the testing policy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider } from "../lib/auth";
import { Login } from "./Login";

// ---------------------------------------------------------------------------
// Mock ONLY the external API boundary -- nothing else
// ---------------------------------------------------------------------------
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    login: vi.fn(),
  };
});

import { login as apiLogin, ApiError } from "../lib/api";

const mockApiLogin = vi.mocked(apiLogin);

// ---------------------------------------------------------------------------
// Helper: wrap Login in AuthProvider (required by useAuth)
// ---------------------------------------------------------------------------
function renderLogin() {
  return render(
    <AuthProvider>
      <Login />
    </AuthProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Login integration (Tailwind design-system)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- AC 2: Card container has bg-card class --
  it("renders the card container with bg-card Tailwind class", () => {
    renderLogin();

    // The card is the container holding the heading and form.
    // It uses bg-card among other classes. We locate it via the heading
    // and then check its parent container.
    const heading = screen.getByRole("heading", { level: 1 });
    const card = heading.closest(".bg-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("bg-card")).toBe(true);
  });

  // -- AC 3: Submit button has bg-primary class --
  it("renders the submit button with bg-primary Tailwind class", () => {
    renderLogin();

    const button = screen.getByRole("button", { name: "Sign In" });
    expect(button.classList.contains("bg-primary")).toBe(true);
  });

  // -- AC 4: Heading renders "T-Minus" with text-foreground class --
  it('renders heading "T-Minus" with text-foreground Tailwind class', () => {
    renderLogin();

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("T-Minus");
    expect(heading.classList.contains("text-foreground")).toBe(true);
  });

  // -- General structure: form elements render correctly --
  it("renders email and password inputs with correct labels", () => {
    renderLogin();

    const emailInput = screen.getByLabelText("Email");
    expect(emailInput).toBeInTheDocument();
    expect(emailInput).toHaveAttribute("type", "email");

    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toBeInTheDocument();
    expect(passwordInput).toHaveAttribute("type", "password");
  });

  it("renders the subtitle text", () => {
    renderLogin();

    expect(
      screen.getByText("Calendar Federation Engine"),
    ).toBeInTheDocument();
  });

  // -- Positive path: successful login --
  it("calls apiLogin on form submission with entered credentials", async () => {
    mockApiLogin.mockResolvedValueOnce({
      access_token: "tok-abc",
      refresh_token: "ref-xyz",
      user: { id: "u1", email: "test@example.com", tier: "free" },
    });

    renderLogin();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.type(screen.getByLabelText("Password"), "securepass1");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    expect(mockApiLogin).toHaveBeenCalledOnce();
    expect(mockApiLogin).toHaveBeenCalledWith(
      "test@example.com",
      "securepass1",
    );
  });

  // -- Negative path: API error displays error message --
  it("displays API error message when login fails", async () => {
    mockApiLogin.mockRejectedValueOnce(
      new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password"),
    );

    renderLogin();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "bad@example.com");
    await user.type(screen.getByLabelText("Password"), "wrongpass1");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(
        screen.getByText("Invalid email or password"),
      ).toBeInTheDocument();
    });
  });

  // -- Negative path: network error displays generic message --
  it("displays generic error message on network failure", async () => {
    mockApiLogin.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    renderLogin();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "net@example.com");
    await user.type(screen.getByLabelText("Password"), "password1");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(
        screen.getByText("Network error. Please try again."),
      ).toBeInTheDocument();
    });
  });

  // -- Loading state: button shows "Signing in..." while submitting --
  it("shows loading state while login request is in flight", async () => {
    // Never resolve to keep the loading state visible
    mockApiLogin.mockReturnValueOnce(new Promise(() => {}));

    renderLogin();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "slow@example.com");
    await user.type(screen.getByLabelText("Password"), "password1");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Signing in..." }),
      ).toBeDisabled();
    });
  });
});
