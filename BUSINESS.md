# T-Minus UI/UX Redesign -- Business Requirements

> **Owner**: Business Analyst
> **Status**: Draft
> **Created**: 2026-02-26
> **Scope**: Full visual redesign of the T-Minus web application (14 pages)

---

## 1. Business Outcomes

### 1.1 Primary Objective

Transform the T-Minus web UI from a functional-but-generic dark Tailwind application into a premium, ops-dashboard-grade experience that users **actively prefer** to their native calendar apps (Google Calendar, Apple Calendar, Outlook).

The Business Owner's directive: _"I want users to prefer going to manage the calendar, not because of sync functionality but because it's nicer, slick, effortless, intuitive, and clean."_

### 1.2 Measurable Outcomes

| Outcome | Metric | Target | Measurement |
|---------|--------|--------|-------------|
| **Increased session duration** | Avg. time-on-app per session | +40% over baseline | Analytics (post-launch 30-day window) |
| **Reduced time-to-action** | Avg. clicks to complete core tasks (create event, check sync status, link account) | Parity or fewer vs. current | Task-timing audit before/after |
| **Visual quality perception** | User survey: "Does T-Minus feel premium?" (1-5 scale) | >= 4.2 avg | Post-redesign survey (n >= 20) |
| **Preference over native** | User survey: "Do you prefer T-Minus to your native calendar UI?" | >= 60% "yes" or "strongly yes" | Post-redesign survey (n >= 20) |
| **Error-state clarity** | User can identify and resolve sync errors without documentation | >= 80% task success rate | Usability test (n >= 5) |
| **Zero regressions** | Existing test suite passes | 100% pass rate | CI pipeline |

### 1.3 Business Value

- **Retention**: A premium feel keeps users engaged even before advanced features (scheduling, relationships) ship in Phases 3-4.
- **Funding optics**: Investor demos benefit enormously from polished UI. The Settlement Monitor aesthetic projects sophistication.
- **Differentiation**: No calendar federation tool looks like an ops dashboard. This is a deliberate positioning choice -- T-Minus is infrastructure for your time, not just another calendar.
- **Foundation for Phase 2+**: The design system established here will carry through MCP integration, scheduling intelligence, and relationship management without future visual rework.

---

## 2. User Personas

### 2.1 Power Founder (Primary)

- **Who**: Startup founder or senior executive managing 3-7 Google/Microsoft/ICS calendar accounts.
- **Pain**: Constantly context-switching between calendar apps. Missed meetings from federation gaps. No single pane of glass.
- **Values**: Speed, information density, zero friction. Wants to glance and know the state of their day across all accounts.
- **Aesthetic expectation**: Uses tools like Linear, Raycast, Arc, Superhuman. Expects dark-mode-first, keyboard-friendly, fast.
- **Key pages**: Calendar, Sync Status, Accounts, Onboarding.

### 2.2 Ops-Minded Professional (Secondary)

- **Who**: Chief of Staff, EA, or operations person managing calendars for others.
- **Pain**: Needs visibility into sync health, policy configuration, error states across multiple accounts.
- **Values**: Data clarity, status-at-a-glance, reliable indicators. Wants a control panel, not a consumer app.
- **Aesthetic expectation**: Familiar with Datadog, Grafana, PagerDuty dashboards. Appreciates data density with clear hierarchy.
- **Key pages**: Sync Status, Provider Health, Error Recovery, Policies, Governance.

### 2.3 Relationship Builder (Future, Phase 3-4)

- **Who**: Sales leader, networker, or anyone who treats relationships as professional infrastructure.
- **Pain**: Losing touch with important contacts. No system connecting calendar interactions to relationship health.
- **Values**: Visual relationship drift indicators, interaction history, reconnection prompts.
- **Key pages**: Relationships, Reconnections, Scheduling.

---

## 3. Scope

### 3.1 Page Classification

Each page is classified into one of three tiers based on user traffic, business impact, and visual complexity.

#### Tier 1 -- Full Redesign (highest impact, user-facing daily)

These pages are where users spend 80%+ of their time. They must embody the full target aesthetic.

| Page | Rationale |
|------|-----------|
| **Calendar** (week/month/day grid, event creation, briefing panel) | The core product surface. First thing users see after login. Must feel like a premium ops dashboard, not a generic calendar widget. |
| **Login** | First impression. Sets the tone for the entire product. Must feel intentional and premium from the first pixel. |
| **Onboarding** (OAuth multi-provider flow) | Second impression. Conversion-critical. A polished onboarding flow increases account-linking completion rate. |
| **Accounts** (link/unlink, scope management, federation settings) | Core management surface. Users return here when adding/removing providers. |
| **Sync Status** (per-account health dashboard) | The "ops dashboard" page. Status dots, health indicators, auto-refresh -- this is where the Settlement Monitor aesthetic pays off most. |

#### Tier 2 -- Themed Polish (visible, less frequent)

These pages inherit the design system (colors, typography, spacing, card styles) but do not require bespoke animation work or layout rethinking.

| Page | Rationale |
|------|-----------|
| **Policies** (account-pair detail matrix) | Visited during setup and occasional reconfiguration. Matrix layout is already data-dense; needs theme alignment, not reimagination. |
| **Provider Health** | Operational page. Visited when things break. Theme alignment sufficient. |
| **Error Recovery** | Operational page. Needs clear visual hierarchy for error states but not bespoke layout. |
| **Billing** (plans, usage, Stripe) | Important but standard. Plan cards, usage bars, and history list need theme application. |

#### Tier 3 -- Theme Inheritance Only (future phases, low current traffic)

These pages are Phase 3-4 features with minimal current usage. They receive the design system tokens (colors, fonts, spacing) automatically via CSS custom properties and Tailwind config. No dedicated design work now.

| Page | Rationale |
|------|-----------|
| **Scheduling** (meeting proposals) | Phase 3 feature. Minimal current content. Will get dedicated design when feature ships. |
| **Governance** (commitment tracking) | Phase 3 feature. Same rationale. |
| **Relationships** (contacts, drift, reputation) | Phase 4 feature. Currently a large page but strategically future. |
| **Reconnections** (trip-based) | Phase 4 feature. Same rationale. |
| **Admin** (enterprise team management) | Enterprise-only. Very low traffic. Theme tokens are sufficient. |

### 3.2 Shared Infrastructure (Applies to All Tiers)

These cross-cutting concerns affect every page and must be implemented first.

| Component | Scope |
|-----------|-------|
| **Design tokens** (`index.css`) | Replace current slate-dark palette with Settlement Monitor palette. All pages inherit automatically. |
| **Tailwind config** (`tailwind.config.ts`) | Add gold accent, glow keyframes, font-family extensions (Inter + JetBrains Mono). |
| **App Shell** (sidebar + header) | Redesign sidebar, header, and responsive behavior. Every authenticated page lives inside this. |
| **UI primitives** (`components/ui/*`) | Restyle Card, Button, Badge, Dialog, Tooltip, Skeleton, Toast, Separator. Every page uses these. |
| **Typography** | Install and configure Inter (sans) + JetBrains Mono (mono/data). Define heading, body, label, and data typographic scales. |
| **Loading/Empty/Error states** | Standardize the skeleton, empty state, and error state patterns using new design tokens. |

---

## 4. Priority Ranking (Implementation Order)

The redesign should be executed in this sequence. Each phase builds on the previous and produces a shippable increment.

### Phase A: Design System Foundation

**What**: Design tokens, Tailwind config, fonts, CSS custom properties.
**Why**: Every subsequent change depends on these. Changing tokens once propagates everywhere.
**Deliverables**:
- Updated `index.css` with Settlement Monitor palette
- Updated `tailwind.config.ts` with gold accent, animation keyframes, font families
- Font loading (Inter via Google Fonts or self-hosted, JetBrains Mono for data)
- Verified: existing tests still pass (pure CSS change, zero component changes)

### Phase B: UI Primitives and App Shell

**What**: Restyle `components/ui/*` (Card, Button, Badge, Dialog, Tooltip, Skeleton, Toast, Separator), AppShell, Sidebar, PageHeader, LoadingSpinner, EmptyState, ErrorBoundary.
**Why**: These are the building blocks. Once primitives look right, 70% of every page improves automatically.
**Deliverables**:
- Restyled primitives with new border colors, background tones, subtle glow effects
- Sidebar redesign: gold-accent active states, uppercase tracking-wider labels, refined icon sizing
- Header redesign: minimal, breathable, monospace data elements
- Framer Motion installation and entrance animation patterns (card fade-in, stagger)

### Phase C: Tier 1 Pages -- Full Redesign

**What**: Calendar, Login, Onboarding, Accounts, Sync Status.
**Why**: These are the daily-use surfaces. Users experience the redesign here.
**Deliverables** (per page):
- **Login**: Centered card with subtle border glow, gold accent on CTA, JetBrains Mono for "Calendar Federation Engine" subtitle
- **Onboarding**: Step indicators with glow transitions, provider cards with entrance animations
- **Calendar**: Refined grid with near-black cells, gold current-day highlight, event cards with provider-color coding, briefing panel slide-in
- **Accounts**: Account cards with status glow dots (2s cycle), provider logos, scope badges
- **Sync Status**: Full ops-dashboard treatment -- health dots with soft glow, data table with JetBrains Mono values, overall health banner with animated transitions

### Phase D: Tier 2 Pages -- Themed Polish

**What**: Policies, Provider Health, Error Recovery, Billing.
**Why**: These pages need to match the new visual system but do not need bespoke layout work.
**Deliverables**:
- Apply new Card/Button/Badge styles
- Ensure color coding (policy levels, health states, billing tiers) works with new palette
- Replace any hardcoded hex values with design token references
- Verify visual consistency with Tier 1 pages

---

## 5. Constraints

### 5.1 Must NOT Change

| Constraint | Rationale |
|------------|-----------|
| **API contracts** | Zero backend changes. The redesign is purely frontend. All `useApi()` hooks, request/response shapes, and error handling remain identical. |
| **Route structure** | All existing routes (`/calendar`, `/accounts`, `/sync-status`, `/policies`, `/errors`, `/provider-health`, `/billing`, `/scheduling`, `/governance`, `/relationships`, `/reconnections`, `/admin`) must remain at the same paths. |
| **Test coverage** | All existing unit tests must continue to pass. Test selectors (`data-testid`) must be preserved. New tests must be added for any new interactive behavior (animations, transitions). |
| **Component public APIs** | Props interfaces for all page components and shared components must remain backward-compatible. Internal implementation can change; external contracts cannot. |
| **Accessibility** | Must maintain WCAG 2.1 AA compliance. New animations must respect `prefers-reduced-motion`. Contrast ratios must meet AA thresholds against the new near-black backgrounds. |
| **Dependencies** | React 19, Vite, Tailwind CSS 3, Radix UI, lucide-react. New additions allowed: Framer Motion, Inter font, JetBrains Mono font. No other new runtime dependencies without explicit approval. |
| **Performance budget** | Page load (LCP) must not regress. Target: LCP < 2.5s on 3G simulation. Total JS bundle increase from new dependencies (Framer Motion) must stay under 30KB gzipped. |

### 5.2 Must Preserve

| Element | Detail |
|---------|--------|
| **Responsive behavior** | Desktop sidebar (240px) + mobile hamburger pattern must continue working. Breakpoint at 768px. |
| **Sidebar navigation structure** | Core / Configuration / Business grouping with the same routes and icons. Visual treatment changes; information architecture does not. |
| **Auto-refresh intervals** | Sync Status (30s), Provider Health -- these polling patterns are load-tested and must not change. |
| **Optimistic updates** | Policies page optimistic UI with rollback. Calendar event creation/update/delete patterns. |
| **Error recovery flows** | Error states, retry buttons, and graceful degradation patterns must remain functional. |

---

## 6. Success Criteria

### 6.1 Acceptance Gates

Each phase has specific gates that must be met before proceeding.

#### Phase A Gate (Design System Foundation)
- [ ] All CSS custom properties updated to Settlement Monitor palette
- [ ] Tailwind config extended with gold accent, glow animations, font families
- [ ] Inter and JetBrains Mono fonts load correctly
- [ ] 100% existing test suite passes (zero visual regressions in behavior)
- [ ] `pnpm build:web` succeeds with no errors

#### Phase B Gate (UI Primitives and App Shell)
- [ ] All 8 primitive components (`Card`, `Button`, `Badge`, `Dialog`, `Tooltip`, `Skeleton`, `Toast`, `Separator`) restyled
- [ ] AppShell sidebar matches target aesthetic (near-black bg, gold active state, uppercase labels)
- [ ] Framer Motion installed, entrance animation pattern documented and working
- [ ] 100% existing test suite passes
- [ ] Manual visual QA: sidebar, header, card, button, badge on desktop and mobile viewport

#### Phase C Gate (Tier 1 Pages)
- [ ] All 5 Tier 1 pages match target aesthetic in desktop and mobile viewports
- [ ] Login page renders in < 1s (no layout shift)
- [ ] Calendar grid performance: 100 events render without jank (60fps scroll)
- [ ] Sync Status health dots animate with 2s glow cycle
- [ ] 100% existing test suite passes
- [ ] New tests for any added interactive behavior

#### Phase D Gate (Tier 2 Pages)
- [ ] All 4 Tier 2 pages visually consistent with Tier 1
- [ ] No hardcoded hex colors remain (all via design tokens)
- [ ] 100% existing test suite passes

### 6.2 Overall Redesign Success

The redesign is complete when:

1. All Phase A-D gates pass.
2. The full test suite (unit + integration) passes in CI.
3. Build output (`pnpm build:web`) produces a valid bundle with no type errors.
4. A qualitative review confirms the UI matches the Settlement Monitor reference aesthetic in spirit and execution.
5. The application feels faster, not slower, than before (perception driven by animation timing, not actual speed regression).

---

## 7. Non-Functional Requirements

### 7.1 Performance

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| **LCP (Largest Contentful Paint)** | < 2.5s on simulated 3G | Google "Good" threshold. Calendar grid is the likely LCP element. |
| **CLS (Cumulative Layout Shift)** | < 0.1 | Font loading (Inter, JetBrains Mono) must use `font-display: swap` with proper fallback metrics to prevent shift. |
| **FID (First Input Delay)** | < 100ms | No heavy JS in critical path. Framer Motion animations must not block input. |
| **Bundle size delta** | < 30KB gzipped increase | Framer Motion is ~15KB gzipped (tree-shaken). Font files are loaded via CSS, not bundled. |
| **Animation frame budget** | 60fps during all animations | GPU-accelerated properties only (`transform`, `opacity`). No layout-triggering animations (`width`, `height`, `margin`). |

### 7.2 Accessibility

| Requirement | Standard | Detail |
|-------------|----------|--------|
| **Color contrast** | WCAG 2.1 AA (4.5:1 for normal text, 3:1 for large text) | The near-black background (#0a0a0f) demands high-contrast foreground colors. Muted text must still meet 4.5:1 against card surfaces. |
| **Motion sensitivity** | `prefers-reduced-motion` | All Framer Motion animations and CSS glow cycles must be disabled or reduced when the user has this preference set. |
| **Focus indicators** | Visible focus ring on all interactive elements | Gold accent (#C5A04E) as focus ring color. Must be visible against both background and card surfaces. |
| **Keyboard navigation** | Full keyboard operability | No animation-dependent interactions. All features accessible via Tab, Enter, Escape, Arrow keys. |
| **Screen reader** | ARIA labels preserved | All existing `aria-label`, `role`, and `data-testid` attributes must be maintained. |

### 7.3 Animation Budget

Animations are a core part of the premium feel, but they must be disciplined.

| Animation | Property | Duration | Easing | Context |
|-----------|----------|----------|--------|---------|
| **Card entrance** | `opacity` + `translateY` | 300ms | `ease-out` | Page load, staggered by 50ms per card |
| **Status dot glow** | `box-shadow` opacity | 2000ms cycle | `ease-in-out` | Sync Status health indicators, always-on |
| **Sidebar active state** | `background-color` + `border-left` | 150ms | `ease` | Route change |
| **Page transition** | `opacity` | 200ms | `ease` | Route change, crossfade |
| **Button hover** | `background-color` + `box-shadow` | 150ms | `ease` | Interactive feedback |
| **Modal entrance** | `opacity` + `scale` | 200ms | `ease-out` | Dialog open |
| **Toast slide-in** | `translateX` | 300ms | `ease-out` | Notification appearance |

Total concurrent animations on any single page: maximum 3 distinct animation types. Status dot glows are exempt from this count (GPU-composited, negligible cost).

### 7.4 Design Token Specification (Target Palette)

These are the target values that Phase A must implement.

```css
:root {
  /* Background layers */
  --background:          240 20% 3.7%;        /* #0a0a0f  near-black */
  --card:                240 16.7% 8.6%;      /* #111118  card surface */
  --card-foreground:     0 0% 93%;            /* #ededed  light text */

  /* Borders */
  --border:              240 13% 15%;         /* #1e1e2e  subtle */

  /* Primary = gold accent */
  --primary:             43 49% 53%;          /* #C5A04E  gold */
  --primary-foreground:  0 0% 0%;             /* #000000  text on gold */

  /* Secondary */
  --secondary:           240 10% 12%;         /* #1a1a24  slightly lighter than card */
  --secondary-foreground: 0 0% 80%;           /* #cccccc */

  /* Muted */
  --muted:               240 10% 12%;         /* #1a1a24 */
  --muted-foreground:    240 5% 50%;          /* #797980  subdued text */

  /* Accent = gold (same as primary for consistency) */
  --accent:              43 49% 53%;          /* #C5A04E */
  --accent-foreground:   0 0% 0%;

  /* Semantic states -- these stay close to current but adjusted for palette */
  --destructive:         0 72% 51%;           /* #d93025  red, slightly muted */
  --destructive-foreground: 0 0% 100%;
  --success:             152 69% 31%;         /* #188038  google-calendar green */
  --success-foreground:  0 0% 100%;
  --warning:             43 96% 56%;          /* #f9ab00  amber, harmonizes with gold */
  --warning-foreground:  0 0% 0%;

  /* Input & focus */
  --input:               240 13% 15%;         /* same as border */
  --ring:                43 49% 53%;          /* gold focus ring */

  --radius: 0.5rem;
}
```

### 7.5 Typography Specification

| Role | Font | Weight | Size | Letter-spacing | Use |
|------|------|--------|------|---------------|-----|
| **Heading 1** | Inter | 700 (bold) | 1.5rem / 24px | -0.02em | Page titles |
| **Heading 2** | Inter | 600 (semibold) | 1.125rem / 18px | -0.01em | Section headers |
| **Body** | Inter | 400 (regular) | 0.875rem / 14px | 0 | Default text |
| **Label** | Inter | 600 (semibold) | 0.6875rem / 11px | 0.05em (tracking-wider) | Sidebar group titles, card labels, uppercase labels |
| **Data value** | JetBrains Mono | 400 (regular) | 0.8125rem / 13px | 0 | Timestamps, counts, IDs, email addresses, sync times |
| **Data label** | Inter | 500 (medium) | 0.75rem / 12px | 0.04em | Column headers in tables, data labels |
| **Button** | Inter | 600 (semibold) | 0.8125rem / 13px | 0.01em | Button text |

---

## 8. Reference Aesthetic: Settlement Monitor (PointSphere)

For the technical team's reference, the target aesthetic is drawn from the PointSphere Settlement Monitor. Key characteristics to replicate in spirit (not pixel-for-pixel):

1. **Near-black base**: The background is not gray, not slate -- it is nearly black. Cards float above it as slightly lighter panels, creating depth through luminance, not color.

2. **Gold as the singular accent**: Gold (#C5A04E) is used with extreme restraint. It marks the single most important element on any given view -- the active nav item, the primary CTA, the current day, a critical status indicator. It is never used for decoration.

3. **Dual-font discipline**: Sans-serif (Inter) for all human-language text. Monospace (JetBrains Mono) for all machine/data text (timestamps, counts, email addresses, IDs). This separation creates instant visual hierarchy between "what to read" and "what to scan."

4. **Uppercase labels with wide tracking**: Section headers and category labels use uppercase + letter-spacing. This is a signposting mechanism, not a stylistic choice. It separates navigation/structure from content.

5. **Soft glow, not hard borders**: Status indicators (health dots, active nav items) use a subtle `box-shadow` glow rather than hard outlines. The glow animates on a 2s cycle for live-status elements, communicating "this is alive" without being distracting.

6. **Data density with breathing room**: Every pixel serves information, but generous padding between data groups prevents overwhelm. The principle is: dense within a card, spacious between cards.

7. **No decorative flourish**: No gradients, no illustrations, no rounded avatars, no emoji. Visual interest comes from information hierarchy, animation subtlety, and the contrast between the near-black canvas and the gold accent.

---

## 9. Out of Scope

The following are explicitly **not** part of this redesign effort:

- **Backend changes**: No API modifications, no worker changes, no schema migrations.
- **New features**: No new pages, no new functionality. This is a visual-only transformation of existing surfaces.
- **Mobile native**: The iOS app (`/ios`) is not in scope. Web responsive behavior is in scope.
- **Marketing site** (`/site`): The static HTML pages (index.html, pricing.html, features.html, developers.html) are not in scope.
- **Light mode**: T-Minus remains dark-only. No light mode toggle.
- **i18n / l10n**: No internationalization changes.
- **Phase 3-4 feature UI design**: Scheduling, Governance, Relationships, and Reconnections will get dedicated design work when those features ship. They only receive token inheritance now.

---

## 10. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Contrast failures** | Medium | High | Validate all text/background pairs against WCAG AA before merging. Use automated contrast checker in CI if feasible. |
| **Animation jank on low-end devices** | Low | Medium | Use GPU-composited properties only. Test on throttled CPU (Chrome DevTools 4x slowdown). |
| **Font loading flash (FOUT)** | Medium | Low | Use `font-display: swap` with appropriate fallback font metrics. Consider self-hosting fonts to avoid CDN dependency. |
| **Test breakage from class name changes** | Low | High | Tests use `data-testid`, not class names. CSS-only changes should not break tests. Verify in Phase A. |
| **Framer Motion bundle bloat** | Low | Medium | Tree-shake aggressively. Import only `motion` and `AnimatePresence` from `framer-motion`. Monitor bundle size with `vite-plugin-inspect`. |
| **Gold accent overuse** | Medium | Medium | Design review checkpoint: gold should appear in at most 2-3 elements per viewport. If it appears more, something is wrong. |

---

## Appendix A: Current File Inventory

For team reference, the files that will be modified during this redesign.

### Design System (Phase A)
- `/Users/ramirosalas/workspace/tminus/src/web/src/index.css` -- CSS custom properties
- `/Users/ramirosalas/workspace/tminus/src/web/tailwind.config.ts` -- Tailwind extensions

### Shared Components (Phase B)
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/AppShell.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/Sidebar.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/PageHeader.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/LoadingSpinner.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/EmptyState.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/ErrorBoundary.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/ui/card.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/ui/button.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/ui/badge.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/ui/dialog.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/ui/tooltip.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/ui/skeleton.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/ui/toast.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/ui/separator.tsx`

### Tier 1 Pages (Phase C)
- `/Users/ramirosalas/workspace/tminus/src/web/src/pages/Login.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/pages/Onboarding.test.tsx` (page file TBD -- may be generated)
- `/Users/ramirosalas/workspace/tminus/src/web/src/pages/Calendar.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/UnifiedCalendar.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/BriefingPanel.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/EventCreateForm.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/components/EventDetail.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/lib/accounts.ts` (Accounts page)
- `/Users/ramirosalas/workspace/tminus/src/web/src/pages/SyncStatus.tsx`

### Tier 2 Pages (Phase D)
- `/Users/ramirosalas/workspace/tminus/src/web/src/pages/Policies.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/pages/ErrorRecovery.tsx`
- `/Users/ramirosalas/workspace/tminus/src/web/src/pages/Billing.tsx`
- Provider Health page (file TBD)

### New Files (expected)
- Font CSS or `@font-face` declarations (likely in `index.css` or a new `fonts.css`)
- Framer Motion animation utility/wrapper (likely in `src/web/src/lib/` or `src/web/src/components/`)
