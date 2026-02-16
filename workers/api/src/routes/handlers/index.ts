/**
 * Route group registry -- ordered list of all route groups.
 *
 * The dispatcher tries each group in order until one returns a Response.
 *
 * IMPORTANT: Order matters! More-specific path prefixes must come before
 * less-specific ones (e.g., delegation routes before org routes, since both
 * match /v1/orgs/* patterns).
 */

import type { RouteGroupHandler } from "../shared";

import { routePrivacyRoutes } from "./privacy-routes";
import { routeApiKeyRoutes } from "./api-keys";
import { routeAccountRoutes } from "./accounts";
import { routeOnboardingRoutes } from "./onboarding";
import { routeFeedRoutes } from "./feeds-routes";
import { routeEventRoutes } from "./events";
import { routePolicyRoutes } from "./policies";
import { routeSyncRoutes } from "./sync";
import { routeSchedulingRoutes } from "./scheduling";
import { routeRelationshipRoutes } from "./relationships";
import { routeVipRoutes } from "./vip";
import { routeCommitmentRoutes } from "./commitments";
import { routeBillingRoutes } from "./billing-routes";
import { routeCalDavRoutes } from "./caldav";
import { routeIntelligenceRoutes } from "./intelligence";
import { routeGraphRoutes } from "./graph";
import { routeDelegationRoutes } from "./delegation-routes";
import { routeOrgRoutes } from "./org-routes";

/**
 * Ordered list of all route groups for the authenticated request dispatcher.
 */
export const routeGroups: RouteGroupHandler[] = [
  routePrivacyRoutes,
  routeApiKeyRoutes,
  routeAccountRoutes,
  routeOnboardingRoutes,
  routeFeedRoutes,
  routeEventRoutes,
  routePolicyRoutes,
  routeSyncRoutes,
  routeSchedulingRoutes,
  routeRelationshipRoutes,
  routeVipRoutes,
  routeCommitmentRoutes,
  routeBillingRoutes,
  routeCalDavRoutes,
  routeIntelligenceRoutes,
  routeGraphRoutes,
  routeDelegationRoutes, // Must come before routeOrgRoutes (both match /v1/orgs/*)
  routeOrgRoutes,
];
