/**
 * Unit tests for shadcn/ui-style components.
 *
 * Verifies rendering, variants, accessibility attributes, and ref forwarding.
 */
import { createRef } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "./button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./card";
import { Badge } from "./badge";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

describe("Button", () => {
  it("renders with default variant and size", () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole("button", { name: "Click me" });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain("bg-primary");
  });

  it("renders destructive variant", () => {
    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toContain("bg-destructive");
  });

  it("renders outline variant", () => {
    render(<Button variant="outline">Cancel</Button>);
    const btn = screen.getByRole("button", { name: "Cancel" });
    expect(btn.className).toContain("border");
  });

  it("renders small size", () => {
    render(<Button size="sm">Small</Button>);
    const btn = screen.getByRole("button", { name: "Small" });
    expect(btn.className).toContain("h-9");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Ref test</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("passes disabled prop", () => {
    render(<Button disabled>Disabled</Button>);
    const btn = screen.getByRole("button", { name: "Disabled" });
    expect(btn).toBeDisabled();
  });

  it("handles onClick", () => {
    const handler = vi.fn();
    render(<Button onClick={handler}>Click</Button>);
    screen.getByRole("button", { name: "Click" }).click();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("merges custom className", () => {
    render(<Button className="my-custom">Custom</Button>);
    const btn = screen.getByRole("button", { name: "Custom" });
    expect(btn.className).toContain("my-custom");
  });
});

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

describe("Card", () => {
  it("renders compound card structure", () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description text</CardDescription>
        </CardHeader>
        <CardContent>Content area</CardContent>
        <CardFooter>Footer area</CardFooter>
      </Card>,
    );

    expect(screen.getByTestId("card")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Description text")).toBeInTheDocument();
    expect(screen.getByText("Content area")).toBeInTheDocument();
    expect(screen.getByText("Footer area")).toBeInTheDocument();
  });

  it("Card forwards ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Card ref={ref}>Card</Card>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it("Card has bg-card class", () => {
    render(<Card data-testid="card">Content</Card>);
    expect(screen.getByTestId("card").className).toContain("bg-card");
  });
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

describe("Badge", () => {
  it("renders with default variant", () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("New").className).toContain("bg-primary");
  });

  it("renders destructive variant", () => {
    render(<Badge variant="destructive">Error</Badge>);
    expect(screen.getByText("Error").className).toContain("bg-destructive");
  });

  it("renders success variant", () => {
    render(<Badge variant="success">OK</Badge>);
    expect(screen.getByText("OK").className).toContain("bg-success");
  });

  it("renders outline variant", () => {
    render(<Badge variant="outline">Draft</Badge>);
    expect(screen.getByText("Draft").className).toContain("text-foreground");
  });
});

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

describe("Separator", () => {
  it("renders horizontal by default", () => {
    const { container } = render(<Separator />);
    const sep = container.firstElementChild!;
    expect(sep.className).toContain("h-[1px]");
    expect(sep.className).toContain("w-full");
  });

  it("renders vertical orientation", () => {
    const { container } = render(<Separator orientation="vertical" />);
    const sep = container.firstElementChild!;
    expect(sep.className).toContain("w-[1px]");
    expect(sep.className).toContain("h-full");
  });

  it("decorative separator has role=none", () => {
    const { container } = render(<Separator decorative={true} />);
    expect(container.firstElementChild).toHaveAttribute("role", "none");
  });

  it("non-decorative separator has role=separator", () => {
    const { container } = render(<Separator decorative={false} />);
    expect(container.firstElementChild).toHaveAttribute("role", "separator");
  });
});

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

describe("Skeleton", () => {
  it("renders with animate-pulse class", () => {
    const { container } = render(<Skeleton data-testid="skel" />);
    const skel = container.firstElementChild!;
    expect(skel.className).toContain("animate-pulse");
    expect(skel.className).toContain("bg-muted");
  });

  it("accepts custom className", () => {
    const { container } = render(<Skeleton className="h-4 w-40" />);
    const skel = container.firstElementChild!;
    expect(skel.className).toContain("h-4");
    expect(skel.className).toContain("w-40");
  });
});
