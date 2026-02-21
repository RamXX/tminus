/**
 * Sidebar navigation for the T-Minus app shell.
 *
 * Renders navigation links grouped by section (Core, Configuration,
 * Business, Admin). Uses React Router's NavLink for active-state
 * highlighting based on the current route.
 *
 * The Admin section is conditionally shown based on whether the user
 * has an org context (orgId prop).
 */

import { NavLink } from "react-router-dom";
import { Separator } from "./ui/separator";
import { cn } from "../lib/utils";
import {
  Calendar,
  Users,
  RefreshCw,
  Shield,
  Activity,
  AlertTriangle,
  CreditCard,
  Clock,
  Scale,
  Heart,
  PhoneCall,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

export interface SidebarProps {
  /** Whether to show the Admin section. */
  showAdmin: boolean;
  /** Callback fired when a nav link is clicked (used to close mobile menu). */
  onNavigate?: () => void;
}

// ---------------------------------------------------------------------------
// Navigation structure
// ---------------------------------------------------------------------------

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Core",
    items: [
      { label: "Calendar", to: "/calendar", icon: Calendar },
      { label: "Accounts", to: "/accounts", icon: Users },
      { label: "Sync Status", to: "/sync-status", icon: RefreshCw },
    ],
  },
  {
    title: "Configuration",
    items: [
      { label: "Policies", to: "/policies", icon: Shield },
      { label: "Provider Health", to: "/provider-health", icon: Activity },
      { label: "Error Recovery", to: "/errors", icon: AlertTriangle },
    ],
  },
  {
    title: "Business",
    items: [
      { label: "Scheduling", to: "/scheduling", icon: Clock },
      { label: "Governance", to: "/governance", icon: Scale },
      { label: "Relationships", to: "/relationships", icon: Heart },
      { label: "Reconnections", to: "/reconnections", icon: PhoneCall },
      { label: "Billing", to: "/billing", icon: CreditCard },
    ],
  },
];

const ADMIN_GROUP: NavGroup = {
  title: "Admin",
  items: [
    { label: "Admin", to: "/admin", icon: Settings },
  ],
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Sidebar({ showAdmin, onNavigate }: SidebarProps) {
  const groups = showAdmin ? [...NAV_GROUPS, ADMIN_GROUP] : NAV_GROUPS;

  return (
    <nav
      data-testid="sidebar"
      className="flex h-full flex-col gap-2 overflow-y-auto px-3 py-4"
    >
      {groups.map((group, groupIndex) => (
        <div key={group.title}>
          {groupIndex > 0 && <Separator className="my-2" />}
          <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {group.title}
          </p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-accent/15 text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/10 hover:text-foreground",
                    )
                  }
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
