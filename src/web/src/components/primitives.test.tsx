/**
 * Unit tests for design system primitives: LoadingSpinner, EmptyState, PageHeader.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadingSpinner } from "./LoadingSpinner";
import { EmptyState } from "./EmptyState";
import { PageHeader } from "./PageHeader";

// ---------------------------------------------------------------------------
// LoadingSpinner
// ---------------------------------------------------------------------------

describe("LoadingSpinner", () => {
  it("renders with role=status and default label", () => {
    render(<LoadingSpinner />);
    const spinner = screen.getByRole("status");
    expect(spinner).toBeInTheDocument();
    expect(spinner).toHaveAttribute("aria-label", "Loading");
  });

  it("renders with custom label", () => {
    render(<LoadingSpinner label="Fetching data" />);
    const spinner = screen.getByRole("status");
    expect(spinner).toHaveAttribute("aria-label", "Fetching data");
  });

  it("has screen-reader-only text", () => {
    render(<LoadingSpinner label="Processing" />);
    expect(screen.getByText("Processing")).toBeInTheDocument();
  });

  it("accepts size prop", () => {
    const { container } = render(<LoadingSpinner size="lg" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.className.baseVal || svg?.getAttribute("class")).toContain(
      "h-12",
    );
  });

  it("accepts className prop", () => {
    const { container } = render(<LoadingSpinner className="my-custom" />);
    expect(container.firstElementChild?.className).toContain("my-custom");
  });
});

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

describe("EmptyState", () => {
  it("renders title", () => {
    render(<EmptyState title="No events found" />);
    expect(screen.getByText("No events found")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(
      <EmptyState
        title="No events"
        description="Try adding a calendar account."
      />,
    );
    expect(
      screen.getByText("Try adding a calendar account."),
    ).toBeInTheDocument();
  });

  it("renders icon when provided", () => {
    render(
      <EmptyState
        title="Empty"
        icon={<svg data-testid="custom-icon" />}
      />,
    );
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
  });

  it("renders action when provided", () => {
    render(
      <EmptyState
        title="Empty"
        action={<button>Add item</button>}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Add item" }),
    ).toBeInTheDocument();
  });

  it("omits description when not provided", () => {
    const { container } = render(<EmptyState title="Empty" />);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PageHeader
// ---------------------------------------------------------------------------

describe("PageHeader", () => {
  it("renders title as h1", () => {
    render(<PageHeader title="Dashboard" />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Dashboard");
  });

  it("renders description when provided", () => {
    render(
      <PageHeader
        title="Dashboard"
        description="Overview of your calendars"
      />,
    );
    expect(
      screen.getByText("Overview of your calendars"),
    ).toBeInTheDocument();
  });

  it("renders actions slot", () => {
    render(
      <PageHeader
        title="Accounts"
        actions={<button>Link Account</button>}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Link Account" }),
    ).toBeInTheDocument();
  });

  it("omits description and actions when not provided", () => {
    const { container } = render(<PageHeader title="Simple" />);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(0);
  });
});
