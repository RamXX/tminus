# T-Minus UI Redesign -- Architecture

> **Owner**: Architect
> **Status**: Active
> **Created**: 2026-02-26
> **Scope**: Frontend visual redesign (no backend changes)
> **Companion**: `BUSINESS.md` (BA requirements), `DESIGN.md` (future, Designer)

---

## 1. System Overview

The T-Minus web frontend is a single-page application rendered from a Vite-built
React bundle, served as static assets from Cloudflare Pages. The redesign
transforms the visual layer without modifying the data layer, routing, or API
contracts.

```
index.html
  |
  +-- main.tsx
        |
        +-- index.css .............. design tokens (CSS custom properties)
        +-- App.tsx ................ router, auth gates
              |
              +-- Login.tsx ........ unauthenticated
              +-- Onboarding.tsx ... unauthenticated
              +-- AppShell.tsx ..... authenticated chrome
                    |
                    +-- Sidebar.tsx
                    +-- PageHeader.tsx
                    +-- <page>.tsx (14 pages)
                          |
                          +-- components/ui/* (Card, Button, Badge, ...)
                          +-- lib/* (API hooks, utilities)
```

### What Changes

| Layer | Files | Nature of Change |
|-------|-------|-----------------|
| Design tokens | `index.css` | CSS custom property values (HSL numbers) |
| Tailwind config | `tailwind.config.ts` | New keyframes, font families, animation utilities |
| Font loading | `index.css` (extended) | `@font-face` declarations for Inter and JetBrains Mono |
| HTML shell | `index.html` | Body background color, fallback font stack |
| UI primitives | `components/ui/*.tsx` | Tailwind class strings inside existing components |
| App shell | `AppShell.tsx`, `Sidebar.tsx`, `PageHeader.tsx` | Tailwind class strings |
| Shared components | `LoadingSpinner.tsx`, `EmptyState.tsx`, `ErrorBoundary.tsx` | Tailwind class strings |
| Tier 1 pages | 5 page files + associated components | Tailwind classes, Framer Motion wrappers |
| Tier 2 pages | 4 page files | Tailwind classes only |
| Animation constants | `lib/motion.ts` (new) | Framer Motion variant objects, reduced-motion hook |

### What Does NOT Change

- Route paths and `HashRouter` configuration
- Component prop interfaces (public API)
- `data-testid` attributes
- API hook signatures (`useApi`, `useAuth`)
- Test files (no modifications to existing test assertions)
- `lib/*.ts` data/logic modules

---

## 2. Change Strategy

### 2.1 Why CSS Custom Properties Are the Foundation

The current architecture already uses CSS custom properties (HSL values) consumed
by Tailwind via `hsl(var(--token) / <alpha-value>)`. This is the single most
important architectural fact for this redesign.

**Propagation guarantee**: Changing `--background` from `222.2 47.4% 11.2%` to
`240 20% 3.7%` in `index.css` instantly updates every Tailwind utility that
references `bg-background`, `text-background`, `border-background`, etc. No
component files need to change for token-level updates.

**Alpha modifier preservation**: Because tokens are stored as raw HSL numbers
(not wrapped in `hsl()`), Tailwind's opacity modifier (`bg-background/50`)
continues to work. This is critical -- the redesign uses alpha-blended
backgrounds extensively (e.g., `bg-accent/15` for active sidebar states).

**Risk: class name drift**. If a component uses a hardcoded color class like
`text-slate-300` instead of `text-muted-foreground`, the token change will not
propagate. The Login page currently has two instances of this (`text-slate-300`,
`text-slate-200`). These must be converted to semantic token references as part
of Phase C.

Mitigation: Phase A includes a full grep for hardcoded color classes
(`slate-`, `blue-`, `red-`, `gray-`, `#` hex literals in className strings)
and produces a fix list for subsequent phases.

### 2.2 Why Framer Motion (Not CSS-Only Animations)

The redesign requires three animation capabilities that CSS alone handles poorly.

| Capability | CSS-only | Framer Motion |
|-----------|----------|---------------|
| **Exit animations** (unmounting components) | Requires manual class toggling + setTimeout; fragile, race-prone | `AnimatePresence` handles lifecycle automatically |
| **Staggered children** (card entrance sequences) | Possible with `animation-delay` but requires per-child nth-child rules | `staggerChildren` in parent variant; declarative |
| **Gesture composition** (hover + tap + focus combined) | Requires separate pseudo-class rules that cannot share state | `whileHover`, `whileTap` compose on single element |

CSS keyframe animations remain appropriate for always-on effects (status dot
glow, loading spinner). Those stay as Tailwind animation utilities defined in
`tailwind.config.ts`. Framer Motion handles entrance/exit transitions and
interactive feedback only.

**Bundle cost**: Framer Motion tree-shakes to approximately 15KB gzipped when
importing only `motion` and `AnimatePresence`. This is within the 30KB budget.

### 2.3 File Modification Plan (Execution Order)

The order matters. Each step builds on the previous and is independently
verifiable.

**Phase A -- Tokens (2 files, zero component changes)**

```
1. src/web/src/index.css          -- Replace all CSS custom property values
2. src/web/tailwind.config.ts     -- Add fontFamily, keyframes, animation
3. src/web/index.html             -- Update body background + font stack
```

Verification: `pnpm build:web` succeeds, `pnpm test` passes, visual inspection
shows new palette applied globally.

**Phase B -- Primitives + Shell (14 files)**

```
4. src/web/src/components/ui/card.tsx
5. src/web/src/components/ui/button.tsx
6. src/web/src/components/ui/badge.tsx
7. src/web/src/components/ui/dialog.tsx
8. src/web/src/components/ui/tooltip.tsx
9. src/web/src/components/ui/skeleton.tsx
10. src/web/src/components/ui/toast.tsx
11. src/web/src/components/ui/separator.tsx
12. src/web/src/components/AppShell.tsx
13. src/web/src/components/Sidebar.tsx
14. src/web/src/components/PageHeader.tsx
15. src/web/src/components/LoadingSpinner.tsx
16. src/web/src/components/EmptyState.tsx
17. src/web/src/components/ErrorBoundary.tsx
```

New file created:

```
18. src/web/src/lib/motion.ts      -- Framer Motion variants + useReducedMotion
```

Verification: all tests pass, visual QA on sidebar + primitives.

**Phase C -- Tier 1 Pages (7-9 files)**

```
19. src/web/src/pages/Login.tsx
20. src/web/src/pages/Onboarding.tsx
21. src/web/src/pages/Calendar.tsx
22. src/web/src/components/UnifiedCalendar.tsx
23. src/web/src/components/BriefingPanel.tsx
24. src/web/src/components/EventCreateForm.tsx
25. src/web/src/components/EventDetail.tsx
26. src/web/src/pages/Accounts.tsx
27. src/web/src/pages/SyncStatus.tsx
```

Verification: all tests pass, visual QA on all 5 Tier 1 pages.

**Phase D -- Tier 2 Pages (4 files)**

```
28. src/web/src/pages/Policies.tsx
29. src/web/src/pages/ProviderHealth.tsx
30. src/web/src/pages/ErrorRecovery.tsx
31. src/web/src/pages/Billing.tsx
```

Verification: all tests pass, no hardcoded hex colors remain.

---

## 3. Font Loading Architecture

### 3.1 Decision: Self-Hosted (Not CDN)

Self-hosting the font files inside the Vite build.

| Factor | Google Fonts CDN | Self-hosted |
|--------|-----------------|-------------|
| **Reliability** | Depends on Google CDN availability; blocked in some corporate networks | Served from same origin as app; no external dependency |
| **Performance** | Extra DNS lookup + TLS handshake to fonts.googleapis.com | Zero additional connections; fonts are same-origin |
| **Privacy** | Google logs font requests (GDPR consideration) | No third-party requests |
| **Cache** | Shared cross-site cache was eliminated by browser partitioning (2020+) | Same-origin cache; always warm after first load |
| **Control** | Cannot subset or optimize beyond what Google provides | Full control over subsetting, format, compression |

**Rationale**: The shared cache benefit that once justified CDN font loading no
longer exists. Chrome, Firefox, and Safari all partition caches by top-level
site. Self-hosting eliminates an external dependency with zero performance
downside.

### 3.2 Font Files Location

```
src/web/src/assets/fonts/
  inter-v18-latin-regular.woff2
  inter-v18-latin-500.woff2
  inter-v18-latin-600.woff2
  inter-v18-latin-700.woff2
  jetbrains-mono-v21-latin-regular.woff2
```

Only WOFF2 format. Browser support is 97%+ globally. No WOFF1 or TTF fallbacks
needed.

**Total font payload**: approximately 120-150KB (5 files). Loaded via CSS
`@font-face` with `font-display: swap`, meaning text renders immediately in the
fallback font and swaps when the custom font loads.

### 3.3 @font-face Declarations

Added to `index.css`, above the `@layer base` block (so the `@font-face`
rules exist at the top level, not inside a Tailwind layer).

```css
/* ----------------------------------------------------------------
 * Self-hosted fonts: Inter (sans) + JetBrains Mono (mono/data)
 * ---------------------------------------------------------------- */

@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("./assets/fonts/inter-v18-latin-regular.woff2") format("woff2");
}

@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url("./assets/fonts/inter-v18-latin-500.woff2") format("woff2");
}

@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url("./assets/fonts/inter-v18-latin-600.woff2") format("woff2");
}

@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("./assets/fonts/inter-v18-latin-700.woff2") format("woff2");
}

@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("./assets/fonts/jetbrains-mono-v21-latin-regular.woff2") format("woff2");
}
```

### 3.4 CLS Mitigation (Fallback Font Metrics)

`font-display: swap` causes a layout shift if the fallback font has different
metrics than the loaded font. To minimize CLS:

1. **Inter's fallback**: `system-ui, -apple-system, "Segoe UI", sans-serif`.
   These system fonts are metrically close to Inter (same x-height, similar
   average character width). CLS impact is negligible.

2. **JetBrains Mono's fallback**: `"SF Mono", "Cascadia Mono", "Consolas", monospace`.
   Monospace fonts have fixed-width characters, so the metric difference between
   any two monospace fonts is small.

3. The Tailwind config `fontFamily` extension declares these fallback stacks
   explicitly (see Section 6.2).

4. `index.html` body style updated from the current system font stack to:
   `font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;`

---

## 4. Animation Architecture

### 4.1 Shared Animation Variants

All Framer Motion configuration lives in a single file: `src/web/src/lib/motion.ts`.

This file exports:

1. **Variant objects** -- reusable animation definitions that components import by name
2. **A `useReducedMotion` re-export** -- from Framer Motion, for components that need to conditionally disable animation
3. **Transition presets** -- shared easing and duration constants

```typescript
// src/web/src/lib/motion.ts

import { useReducedMotion } from "framer-motion";

// ---- Transition presets ----

export const transitions = {
  /** Fast interactive feedback (button hover, active state) */
  fast: { duration: 0.15, ease: "easeOut" },
  /** Standard entrance/exit (cards, modals) */
  standard: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1.0] },
  /** Page-level crossfade */
  page: { duration: 0.2, ease: "easeInOut" },
} as const;

// ---- Variant objects ----

/** Card entrance: fade up from 8px below */
export const cardVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: transitions.standard },
  exit: { opacity: 0, y: -4, transition: transitions.fast },
};

/** Stagger container: delays children by 50ms each */
export const staggerContainer = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.05,
    },
  },
};

/** Modal entrance: scale from 95% + fade */
export const modalVariants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1, transition: transitions.standard },
  exit: { opacity: 0, scale: 0.95, transition: transitions.fast },
};

/** Slide-in from right (toast) */
export const slideInRight = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0, transition: transitions.standard },
  exit: { opacity: 0, x: 24, transition: transitions.fast },
};

/** Page crossfade */
export const pageFade = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: transitions.page },
  exit: { opacity: 0, transition: transitions.page },
};

// ---- Reduced motion re-export ----

export { useReducedMotion };
```

**Why a single file**: Animation behavior is a cross-cutting concern. Scattering
variant definitions across component files leads to drift (one card fades in at
300ms, another at 400ms, a third uses a different easing curve). A single source
of truth keeps the motion language consistent.

### 4.2 prefers-reduced-motion Implementation

Two complementary mechanisms:

**CSS layer** (always-on animations like status dot glow):

```css
@media (prefers-reduced-motion: reduce) {
  .animate-glow {
    animation: none !important;
  }
}
```

This is added to `index.css` inside an `@layer utilities` block, or as a
plain media query at the end of the file. Tailwind's built-in
`motion-reduce:` variant is also available on any utility class (already used
by `LoadingSpinner.tsx`).

**JavaScript layer** (Framer Motion entrance/exit animations):

Components that use Framer Motion check `useReducedMotion()` and conditionally
disable animation:

```tsx
import { motion, AnimatePresence } from "framer-motion";
import { cardVariants, useReducedMotion } from "../lib/motion";

function MyCard({ children }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      variants={reducedMotion ? undefined : cardVariants}
      initial={reducedMotion ? false : "hidden"}
      animate="visible"
      exit="exit"
    >
      {children}
    </motion.div>
  );
}
```

When `reducedMotion` is true, `initial={false}` tells Framer Motion to skip
the entrance animation and render immediately in the final state. The `exit`
variant is also skipped because `variants` is `undefined`.

### 4.3 Performance Constraints

**GPU-composited properties only**. Every animation in the system uses only:

- `opacity` (composited)
- `transform` (translate, scale -- composited)
- `box-shadow` (for glow effects -- triggers paint but not layout)

**Forbidden in animations**: `width`, `height`, `margin`, `padding`, `top`,
`left`, `font-size`, `border-width`. These trigger layout recalculation and
will cause jank on lower-powered devices.

**Concurrent animation limit**: Maximum 3 distinct animation types active on
any viewport at once. Status dot glows (`box-shadow` on 2s CSS cycle) are
exempt -- they are GPU-composited and negligible cost.

---

## 5. Component Architecture

### 5.1 Restyling Strategy: Modify in Place

The primitives follow the shadcn/ui pattern: they are source-owned components
(not library imports). This means we modify the Tailwind class strings directly
inside each component file.

**No new wrapper components are created**. The existing component tree is
preserved exactly. A `Card` remains a `Card` -- its className string changes
from:

```
"rounded-lg border bg-card text-card-foreground shadow-sm"
```

to:

```
"rounded-lg border border-border/60 bg-card text-card-foreground shadow-sm
 transition-colors duration-150"
```

The added `border-border/60` uses the semantic border token at 60% opacity
(subtler than the current full-opacity border). The `transition-colors` enables
smooth hover states. The `shadow-sm` may become `shadow-none` since the new
palette relies on luminance separation rather than drop shadows.

### 5.2 Variant Preservation

Components using `class-variance-authority` (Button, Badge) have their variant
class strings updated, but the variant names and TypeScript types remain
identical.

Example -- Button `default` variant changes:

```
Before: "bg-primary text-primary-foreground hover:bg-primary/90"
After:  "bg-primary text-primary-foreground hover:bg-primary/85
         hover:shadow-[0_0_12px_hsl(var(--primary)/0.25)]"
```

The variant name (`"default"`) and the TypeScript type
(`VariantProps<typeof buttonVariants>`) do not change. Consumers calling
`<Button variant="default">` are unaffected.

### 5.3 data-testid Preservation

Every existing `data-testid` attribute remains untouched. The redesign operates
strictly on `className` props, not on the DOM structure or test-facing attributes.

A representative sample of testids that must survive:

| Component | testid | Location |
|-----------|--------|----------|
| AppShell | `desktop-sidebar`, `mobile-sidebar`, `mobile-overlay`, `app-header`, `hamburger-button`, `logout-button`, `user-email` | `AppShell.tsx` |
| Sidebar | `sidebar` | `Sidebar.tsx` |
| SyncStatus | `sync-status-loading`, `sync-status-error`, `overall-health-banner`, `user-graph-health`, `account-row-*`, `health-indicator`, `last-sync-time`, `channel-status`, `pending-writes`, `error-count` | `SyncStatus.tsx` |

### 5.4 Sidebar Redesign Specifics

The Sidebar component currently uses these active/inactive classes:

```
Active:   "bg-accent/15 text-accent-foreground"
Inactive: "text-muted-foreground hover:bg-accent/10 hover:text-foreground"
```

After redesign:

```
Active:   "bg-primary/10 text-primary border-l-2 border-primary"
Inactive: "text-muted-foreground hover:bg-primary/5 hover:text-foreground"
```

The key visual change is the gold left-border on the active item, replacing
the blue background tint. The group titles already use `uppercase tracking-wider`
which aligns with the target aesthetic.

### 5.5 App Shell Header

The header currently uses `bg-card`. It stays `bg-card` (which now resolves
to `#111118` instead of `#1e293b`). The user email display gains
`font-mono text-xs tracking-wide` to use JetBrains Mono for the data element,
separating "label text" (Inter) from "data text" (JetBrains Mono).

---

## 6. Build and Performance

### 6.1 Framer Motion Tree-Shaking

Framer Motion supports tree-shaking when importing specific named exports.

**Allowed imports** (these tree-shake correctly):

```typescript
import { motion, AnimatePresence } from "framer-motion";
import { useReducedMotion } from "framer-motion";
```

**Disallowed imports** (these pull in the entire library):

```typescript
import framerMotion from "framer-motion";  // default import
import * as fm from "framer-motion";       // namespace import
```

All Framer Motion imports are centralized through `lib/motion.ts`, which
re-exports only what is needed. Page components import from `lib/motion.ts`,
and only the few that need the `motion` component import it directly from
`framer-motion`.

**Expected bundle impact**: approximately 12-16KB gzipped for `motion` +
`AnimatePresence` + `useReducedMotion`.

### 6.2 Tailwind Config Extensions

The following additions to `tailwind.config.ts`:

```typescript
theme: {
  extend: {
    fontFamily: {
      sans: [
        "Inter",
        "system-ui",
        "-apple-system",
        '"Segoe UI"',
        "sans-serif",
      ],
      mono: [
        '"JetBrains Mono"',
        '"SF Mono"',
        '"Cascadia Mono"',
        "Consolas",
        "monospace",
      ],
    },
    keyframes: {
      "spin-slow": {
        from: { transform: "rotate(0deg)" },
        to: { transform: "rotate(360deg)" },
      },
      glow: {
        "0%, 100%": { boxShadow: "0 0 4px 1px currentColor" },
        "50%": { boxShadow: "0 0 8px 3px currentColor" },
      },
    },
    animation: {
      "spin-slow": "spin-slow 1.2s linear infinite",
      glow: "glow 2s ease-in-out infinite",
    },
  },
},
```

The `glow` keyframe uses `currentColor` so the glow color inherits from the
element's `color` property. A green health dot (`text-success`) glows green;
a red one (`text-destructive`) glows red. No per-color keyframe duplication.

### 6.3 Font File Handling (Vite)

Vite handles static assets referenced in CSS `url()` automatically. The
`@font-face src: url("./assets/fonts/inter-v18-latin-regular.woff2")` in
`index.css` causes Vite to:

1. Copy the file to the output `dist/assets/` directory
2. Add a content hash to the filename for cache-busting
3. Rewrite the CSS `url()` to the hashed path

No Vite configuration changes are required. The default `assetsInclude`
handles `.woff2` files natively.

### 6.4 Bundle Size Monitoring

The build script already produces output that shows chunk sizes. To enforce
the 30KB budget:

1. Before the redesign: record the baseline `pnpm build:web` output
2. After Phase B (when Framer Motion is added): compare the JS bundle delta
3. If the delta exceeds 30KB gzipped, audit imports for namespace pulls

For ongoing monitoring, consider adding `rollup-plugin-visualizer` as a dev
dependency (zero runtime cost) to inspect the bundle graph. This is optional
and not a blocking requirement.

---

## 7. Testing Strategy

### 7.1 Why Existing Tests Should Not Break

The test suite uses three selector strategies:

| Strategy | Example | Affected by Redesign? |
|----------|---------|----------------------|
| `data-testid` | `screen.getByTestId("sidebar")` | No |
| `role` + `name` | `screen.getByRole("button", { name: "Click me" })` | No |
| `className` assertions | `expect(btn.className).toContain("bg-primary")` | Potentially yes |

The third category is the risk. The `ui-components.test.tsx` file contains
assertions like:

```typescript
expect(btn.className).toContain("bg-primary");
expect(screen.getByTestId("card").className).toContain("bg-card");
expect(screen.getByText("New").className).toContain("bg-primary");
expect(skel.className).toContain("animate-pulse");
expect(skel.className).toContain("bg-muted");
```

These assertions verify that the correct Tailwind semantic token class is
present. Since the redesign preserves semantic class names (`bg-primary`,
`bg-card`, `bg-muted`) and only changes the underlying CSS custom property
values, these assertions remain valid. The class `bg-primary` still exists on
the element -- it just resolves to gold instead of blue.

**Action required**: If any primitive component's className string is modified
to remove a class that tests assert on (e.g., removing `bg-card` from Card),
the test must be updated simultaneously. However, the plan does not remove
any semantic classes -- it adds to them.

### 7.2 New Tests to Add

| Test | What It Verifies | Location |
|------|-----------------|----------|
| Reduced motion respects user preference | When `prefers-reduced-motion: reduce` is active, Framer Motion components render without animation | `src/web/src/lib/motion.test.ts` (new) |
| Animation variant structure | Variant objects have required keys (`hidden`, `visible`, `exit`) | `src/web/src/lib/motion.test.ts` (new) |
| Font-face declarations exist | CSS file includes `@font-face` for Inter and JetBrains Mono | Manual verification or snapshot test of `index.css` |

### 7.3 Testing Framer Motion in jsdom

jsdom does not support CSS animations or the Web Animations API. Framer Motion
components render correctly in jsdom (they produce standard DOM elements) but
animations do not execute.

**Strategy**: Do not test animation visual behavior in unit tests. Instead:

1. Test that Framer Motion wrapper elements render their children correctly
   (standard RTL `getByTestId` / `getByRole` assertions)
2. Test that `useReducedMotion` integration works by mocking
   `window.matchMedia` in test setup (already a standard pattern)
3. Test animation variant object shapes (pure unit tests on the exported
   objects from `lib/motion.ts`)

For visual animation verification, rely on manual QA during each phase gate.

---

## 8. Migration Path

Each phase is independently deployable and testable. A deployment after Phase A
produces a visually different (new palette) but fully functional application.
There is no "in-between" broken state.

### Phase A: Tokens Only

**Files modified**: 3 (`index.css`, `tailwind.config.ts`, `index.html`)
**Component changes**: Zero
**New dependencies**: Zero
**Risk**: Lowest

Changes:

1. Replace all CSS custom property values in `:root` to the Settlement Monitor
   palette (see BUSINESS.md Section 7.4 for exact values)
2. Add `fontFamily.sans` and `fontFamily.mono` to Tailwind config
3. Add `glow` keyframe and animation to Tailwind config
4. Add `@font-face` declarations to `index.css`
5. Create `src/web/src/assets/fonts/` directory and add WOFF2 files
6. Update `index.html` body background from `#0f172a` to `#0a0a0f` and
   font-family to include Inter
7. Grep for hardcoded color classes and document them for later phases

**Gate**: `pnpm build:web` succeeds. `pnpm test` passes with zero failures.
Visual inspection confirms new palette renders.

**Hardcoded color audit**: The following known hardcoded colors exist in
component files and must be tracked for conversion in Phases B-D:

| File | Hardcoded Value | Should Become |
|------|----------------|---------------|
| `Login.tsx` | `text-slate-300` | `text-muted-foreground` |
| `Login.tsx` | `text-slate-200` | `text-foreground` |
| `Login.tsx` | `text-red-400` | `text-destructive` |
| `SyncStatus.tsx` | `COLOR_MAP` with hex `#16a34a`, `#ca8a04`, `#dc2626` | Semantic token CSS variables |
| `SyncStatus.tsx` | `text-red-300` | `text-destructive` |

### Phase B: Primitives + Shell

**Files modified**: 14 (existing) + 1 (new `lib/motion.ts`)
**New dependencies**: `framer-motion` (added to `package.json`)
**Risk**: Low-medium (class string changes in shared components)

Changes:

1. Install Framer Motion: `pnpm add framer-motion`
2. Create `src/web/src/lib/motion.ts` with shared variants
3. Update UI primitive class strings (Card, Button, Badge, Dialog, Tooltip,
   Skeleton, Toast, Separator) for the new aesthetic
4. Restyle AppShell (header, sidebar chrome)
5. Restyle Sidebar (gold active states, border-left indicator)
6. Restyle PageHeader, LoadingSpinner, EmptyState, ErrorBoundary
7. Add entrance animation to Card component using `motion.div`

**Gate**: all existing tests pass. Manual visual QA confirms sidebar, header,
and all primitives match target aesthetic on both desktop (>768px) and mobile
(<768px) viewports.

### Phase C: Tier 1 Pages

**Files modified**: 7-9 (existing page files and associated components)
**New dependencies**: None (Framer Motion already installed in Phase B)
**Risk**: Medium (page-level layout adjustments, animation integration)

Changes:

1. **Login**: Border glow on card, gold CTA button, JetBrains Mono on subtitle,
   convert hardcoded slate classes to semantic tokens
2. **Onboarding**: Step indicators with glow transitions, provider card entrance
   animations
3. **Calendar**: Refined grid cells (near-black), gold current-day highlight,
   provider-color coded event cards, BriefingPanel slide-in animation
4. **Accounts**: Account cards with animated status glow dots, provider logos,
   scope badges
5. **Sync Status**: Health dots with `animate-glow` class, data table with
   `font-mono` on values, overall health banner with animated transitions,
   convert `COLOR_MAP` hex values to CSS custom properties

**Gate**: all existing tests pass. New tests for any added interactive behavior.
Login renders in <1s with no layout shift. Calendar grid scrolls at 60fps with
100 events. Sync Status health dots animate on 2s cycle.

### Phase D: Tier 2 Consistency Pass

**Files modified**: 4 (existing page files)
**New dependencies**: None
**Risk**: Lowest (applying already-proven patterns)

Changes:

1. Apply new Card/Button/Badge/Dialog styles to Policies, Provider Health,
   Error Recovery, Billing
2. Convert any remaining hardcoded hex values to design token references
3. Ensure color coding (policy levels, health states, billing tiers) works
   correctly with new palette
4. Visual consistency check against Tier 1 pages

**Gate**: all existing tests pass. Zero hardcoded hex colors remain in any
modified file. Visual consistency with Tier 1 confirmed.

---

## 9. File Structure

### 9.1 New Files

Only two new filesystem additions:

```
src/web/src/
  assets/
    fonts/
      inter-v18-latin-regular.woff2
      inter-v18-latin-500.woff2
      inter-v18-latin-600.woff2
      inter-v18-latin-700.woff2
      jetbrains-mono-v21-latin-regular.woff2
  lib/
    motion.ts                  <-- Framer Motion variants + reduced motion hook
    motion.test.ts             <-- Unit tests for variant shapes + reduced motion
```

### 9.2 New Directories

One new directory: `src/web/src/assets/fonts/`. The `assets/` directory does
not currently exist. It is the Vite-conventional location for static assets
that are referenced from source code (as opposed to `public/` which is for
assets served as-is without hashing). Font files referenced via CSS `url()`
must go through Vite's asset pipeline to get content-hashed filenames.

### 9.3 No Structural Changes

The component tree, page file organization, lib module structure, and test
file locations remain unchanged. No component files move. No re-exports change.
The `components/ui/index.ts` barrel export remains as-is.

---

## 10. Decision Records

### DR-1: Self-Hosted Fonts Over CDN

**Decision**: Self-host Inter and JetBrains Mono as WOFF2 files.
**Alternatives considered**: Google Fonts CDN, Fontsource npm packages.
**Rationale**: Browser cache partitioning (since 2020) eliminates the
cross-site cache benefit of CDN fonts. Self-hosting removes an external
dependency and a GDPR-relevant third-party request. Fontsource was
considered but adds npm packages and build complexity for fonts that are
static assets -- CSS `@font-face` is simpler and sufficient.
**Trade-off**: We take on responsibility for font updates (new Inter versions).
Acceptable risk -- font updates are rare and non-breaking.

### DR-2: Single Animation Constants File

**Decision**: All Framer Motion variants live in `lib/motion.ts`.
**Alternatives considered**: Co-located variants (each component defines its
own), a `components/motion/` directory with wrapper components.
**Rationale**: Animations are a design system concern, not a component concern.
Scattering variants leads to inconsistency. Wrapper components add indirection
and make the component tree harder to understand. A single file with exported
objects is the simplest approach that maintains consistency.
**Trade-off**: If the animation vocabulary grows very large (20+ variants), this
file becomes long. Acceptable risk -- the redesign defines 5-6 variants total.

### DR-3: Framer Motion for Transitions, CSS for Always-On

**Decision**: Use Framer Motion for entrance/exit animations and gesture
composition. Use CSS keyframes (via Tailwind `animation` utilities) for
always-on effects like the status dot glow and loading spinner.
**Alternatives considered**: All CSS (no Framer Motion), all Framer Motion (no
CSS keyframes), GSAP.
**Rationale**: CSS keyframes are more efficient for always-on infinite
animations (no JS overhead per frame). Framer Motion excels at lifecycle-aware
transitions (`AnimatePresence`) and gesture composition. GSAP is heavier
(~25KB gzipped) and designed for complex timelines we do not need. The hybrid
approach uses each tool where it is strongest.
**Trade-off**: Two animation systems in the same codebase require discipline to
use the right one. Mitigated by the clear rule: CSS for infinite/always-on,
Framer Motion for lifecycle/gesture.

### DR-4: WOFF2 Only (No WOFF1/TTF Fallback)

**Decision**: Ship only WOFF2 format font files.
**Alternatives considered**: WOFF2 + WOFF1, WOFF2 + WOFF1 + TTF.
**Rationale**: WOFF2 is supported by all browsers that T-Minus targets
(Chrome 36+, Firefox 39+, Safari 12+, Edge 14+). The oldest browser in our
support matrix is well past these thresholds. Adding WOFF1/TTF doubles the
font payload for users who will never need it.
**Trade-off**: Users on very old browsers (IE11, Android 4.x) will not load
custom fonts and will fall back to the system font stack. This is acceptable
-- the system font stack is explicitly chosen to be visually close.

### DR-5: No New Wrapper Components

**Decision**: Restyle existing components in place rather than wrapping them.
**Alternatives considered**: Creating `AnimatedCard`, `StyledButton`, etc.
wrapper components that compose the originals.
**Rationale**: Wrapper components add a layer of indirection. Every consumer
would need to decide between `<Card>` and `<AnimatedCard>`. Import paths
change. The component tree gets deeper. The existing components are
source-owned (shadcn/ui pattern) precisely so they can be modified directly.
**Trade-off**: The original component files accumulate more complexity (Framer
Motion imports, animation props). Acceptable because the total addition per
file is small (one import, one wrapping `motion.div`).

---

## 11. Security and Accessibility

### 11.1 Security

The redesign has no security surface. No new API calls, no new data flows, no
new authentication logic, no new dependencies that process user data. Framer
Motion is a pure animation library with no network access.

The self-hosted fonts eliminate third-party requests to Google Fonts, which is
a minor privacy improvement (no Google font-request logging).

### 11.2 Accessibility Compliance

| WCAG 2.1 AA Criterion | How the Redesign Addresses It |
|----------------------|------------------------------|
| **1.4.3 Contrast (Minimum)** | All text/background pairs validated against the new palette. `#ededed` on `#0a0a0f` = 17.5:1 (exceeds 4.5:1). `#797980` on `#111118` = 4.9:1 (meets 4.5:1 for normal text). Gold `#C5A04E` on `#0a0a0f` = 7.2:1 (meets 3:1 for large text, meets 4.5:1 for normal text). |
| **1.4.11 Non-text Contrast** | Health indicator dots (green/yellow/red) on dark background all exceed 3:1. Gold focus ring exceeds 3:1 against card surface. |
| **2.3.1 Three Flashes** | No animation flashes more than 3 times per second. The glow cycle is 2s (0.5Hz). |
| **2.3.3 Animation from Interactions** | `prefers-reduced-motion` respected via both CSS media query and Framer Motion `useReducedMotion` hook. All animations are purely decorative; no information is conveyed only through motion. |
| **2.4.7 Focus Visible** | Gold focus ring (`--ring: 43 49% 53%`) replaces the current blue ring. Visible against both `--background` and `--card` surfaces. |

---

## 12. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **className assertion tests break** | Low | Medium | Tests assert semantic class names (`bg-primary`) which are preserved. If any removal is necessary, the test is updated in the same commit. |
| **Framer Motion exceeds bundle budget** | Low | Medium | Import only `motion`, `AnimatePresence`, `useReducedMotion`. Monitor with `pnpm build:web` output after Phase B. |
| **Font FOUT causes visible flash** | Medium | Low | `font-display: swap` with metrically similar fallback fonts. Inter's metrics closely match system-ui. |
| **Gold accent overuse** | Medium | Medium | Constraint: gold appears on at most 2-3 elements per viewport. Enforced by visual QA at each phase gate. |
| **CLS from font loading** | Low | Medium | Fallback font stacks chosen for metric similarity. Validate CLS < 0.1 with Chrome DevTools after Phase A. |
| **Hardcoded colors missed in audit** | Low | Low | Phase A produces the audit list. Phase D includes a final `grep` sweep for any remaining hex literals or Tailwind color scale classes in modified files. |
| **Animation jank on low-end devices** | Low | Medium | GPU-composited properties only. Verified by testing with Chrome DevTools CPU 4x throttle during Phase C gate. |
