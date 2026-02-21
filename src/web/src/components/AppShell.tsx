/**
 * App shell layout with sidebar navigation and top header.
 *
 * Provides the persistent chrome for authenticated pages:
 * - Fixed sidebar (240px) on the left with grouped navigation links
 * - Top header bar with app name, user email, and logout button
 * - Responsive: sidebar collapses to a hamburger menu on viewports < 768px
 *
 * Login and Onboarding pages render outside this shell (full-page layout).
 */

import { useState, useCallback, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Sidebar } from "./Sidebar";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Menu, X, LogOut } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppShellProps {
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AppShell({ children }: AppShellProps) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const handleNavigate = useCallback(() => {
    setMobileMenuOpen(false);
  }, []);

  const toggleMobileMenu = useCallback(() => {
    setMobileMenuOpen((prev) => !prev);
  }, []);

  // Admin link hidden until auth layer exposes org context (user.orgId).
  // Route at /admin/:orgId redirects without orgId anyway.
  const showAdmin = false;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* ----- Desktop sidebar ----- */}
      <aside
        data-testid="desktop-sidebar"
        className="hidden w-60 shrink-0 flex-col border-r border-border bg-card md:flex"
      >
        {/* Sidebar header */}
        <div className="flex h-14 items-center px-6">
          <span className="text-lg font-bold text-foreground">T-Minus</span>
        </div>
        <Separator />
        <Sidebar showAdmin={showAdmin} />
      </aside>

      {/* ----- Mobile sidebar overlay ----- */}
      {mobileMenuOpen && (
        <div
          data-testid="mobile-overlay"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMobileMenuOpen(false);
          }}
          role="button"
          tabIndex={0}
          aria-label="Close navigation menu"
        />
      )}

      <aside
        data-testid="mobile-sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-border bg-card transition-transform duration-200 md:hidden ${
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center justify-between px-6">
          <span className="text-lg font-bold text-foreground">T-Minus</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <Separator />
        <Sidebar showAdmin={showAdmin} onNavigate={handleNavigate} />
      </aside>

      {/* ----- Main content area ----- */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top header */}
        <header
          data-testid="app-header"
          className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-4 md:px-6"
        >
          <div className="flex items-center gap-3">
            {/* Hamburger button -- mobile only */}
            <Button
              data-testid="hamburger-button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={toggleMobileMenu}
              aria-label="Open navigation menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
            {/* App name on mobile (since sidebar is hidden) */}
            <span className="text-lg font-bold text-foreground md:hidden">
              T-Minus
            </span>
          </div>

          <div className="flex items-center gap-3">
            {user && (
              <span
                data-testid="user-email"
                className="text-sm text-muted-foreground"
              >
                {user.email}
              </span>
            )}
            <Button
              data-testid="logout-button"
              variant="ghost"
              size="sm"
              onClick={logout}
              className="gap-2"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Logout</span>
            </Button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
