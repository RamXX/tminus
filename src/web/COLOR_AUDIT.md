# T-Minus Color Audit

**Generated**: 2026-02-26
**Story**: TM-xms4.5
**Scope**: `src/web/src/` -- all `.tsx` and `.ts` files (excluding tests)

## Summary

| Category | Count (non-test) |
|----------|-----------------|
| Tailwind palette classes (`slate-*`, `blue-*`, etc.) | 122 |
| Hardcoded hex colors (`#xxxxxx`) | 355 |
| Hardcoded `rgba()`/`hsl()` inline styles | 4 |
| **Total hardcoded color references** | **481** |

### Documented Exceptions (INTENTIONAL -- do not convert)

| File | What | Why |
|------|------|-----|
| `lib/calendar-utils.ts` | `ACCOUNT_COLORS[]` palette + `FALLBACK_COLOR` | Dynamic per-account coloring via `getAccountColor()` hash. Must be hex for inline `style` binding. |
| `lib/onboarding.ts:122-124` | `PROVIDER_COLORS` (`#4285F4`, `#7B2AE0`, `#555555`) | Google/Microsoft/Apple brand colors. Must match brand guidelines. |
| `lib/provider-health.ts:84-86` | `PROVIDER_COLORS` (`#4285F4`, `#7B1FA2`, `#8E8E93`) | Provider brand colors (same intent, slightly different Microsoft shade). |
| `components/UpgradePromptBanner.tsx:37-39` | `PROVIDER_COLORS` | Provider brand colors reused for upgrade banners. |

---

## Phase Assignment Legend

- **Phase B** (Token Infrastructure): Define new CSS custom properties + Tailwind extensions for semantic status, surface, and text tokens.
- **Phase C** (Library Migration): Convert `lib/` color constants to token references.
- **Phase D** (Component Migration): Convert page/component Tailwind classes and inline styles to tokens.

---

## 1. Inline Style Hex Colors (Highest Priority -- 355 occurrences)

These are hardcoded hex values in `style={{...}}` objects. They cannot use Tailwind classes
and need either CSS variables or a centralized theme object.

### 1a. Surface/Background Colors (recurring theme palette)

The following hex values repeat across many components and represent the app's dark theme surfaces.
They should become CSS custom properties in `index.css`.

| Hex | Tailwind equivalent | Semantic meaning | Occurrences | Recommended token |
|-----|--------------------:|------------------|-------------|-------------------|
| `#0f172a` | slate-900 | Panel/drawer background | 7 | `--surface-panel` |
| `#1e293b` | slate-800 | Elevated surface / table row | 28 | `--surface-elevated` (exists but unused for hex) |
| `#334155` | slate-700 | Border / separator | 20 | `--border-subtle` |
| `#475569` | slate-600 | Border (inputs/buttons) | 6 | `--border-input` |
| `#1e3a5f` | ~blue-900 | Info/admin background | 5 | `--surface-info` |
| `#451a03` | ~amber-950 | Warning background | 2 | `--surface-warning-subtle` |
| `#422006` | ~amber-950 | Warning background (alt) | 2 | `--surface-warning-subtle` |
| `#052e16` | ~green-950 | Success background | 3 | `--surface-success-subtle` |
| `#450a0a` | ~red-950 | Error background | 6 | `--surface-destructive-subtle` |
| `#2d1b1b` | ~red-950/warm | Error banner background | 4 | `--surface-destructive-subtle` |
| `#7f1d1d` | ~red-900 | Error banner border | 4 | `--border-destructive` |
| `#500724` | ~pink-950 | Family tier bg | 1 | `--surface-accent-family` |
| `#2e1065` | ~violet-950 | Personal tier bg | 2 | `--surface-accent-personal` |
| `#083344` | ~cyan-950 | Community tier bg | 1 | `--surface-accent-community` |
| `#3b2f1e` | ~amber dark | VIP tier bg | 1 | `--surface-accent-vip` |
| `#1e3b2f` | ~green dark | Compliant tier bg | 1 | `--surface-accent-compliant` |
| `#064e3b` | ~emerald-950 | Success status bg | 2 | `--surface-success-subtle` |

### 1b. Text Colors (recurring)

| Hex | Tailwind equivalent | Semantic meaning | Occurrences | Recommended token |
|-----|--------------------:|------------------|-------------|-------------------|
| `#f1f5f9` | slate-50 | Heading text | 5 | `--text-heading` or `foreground` |
| `#e2e8f0` | slate-200 | Primary body text | 12 | `--text-primary` or `foreground` |
| `#cbd5e1` | slate-300 | Secondary body text | 6 | `--text-secondary` |
| `#94a3b8` | slate-400 | Muted/helper text | 18 | `--text-muted` or `muted-foreground` |
| `#64748b` | slate-500 | Disabled/subtle text | 14 | `--text-disabled` |
| `#ffffff` | white | Button text on primary bg | 8 | `--text-on-primary` |
| `#000000` | black | Button text on warning bg | 1 | `--text-on-warning` |
| `#fca5a5` | red-300 | Error message text | 8 | `--text-destructive-muted` |

### 1c. Semantic Status Colors (hex in inline styles)

| Hex | Tailwind equivalent | Semantic meaning | Files using it | Recommended token |
|-----|--------------------:|------------------|----------------|-------------------|
| `#3b82f6` | blue-500 | Primary action / info | EventCreateForm, EventDetail, BriefingPanel, OrgPolicyEditor, OrgMemberList, UnifiedCalendar, Billing, UpgradePromptBanner | `--color-info` |
| `#22c55e` | green-500 | Success / on-track | Relationships, EventDetail, BriefingPanel, governance, briefing, scheduling | `--color-success` (or existing `--success`) |
| `#16a34a` | green-600 | Active status | accounts, billing, provider-health, SyncStatus, ProviderHealth | `--color-success-dark` |
| `#ef4444` | red-500 | Error / overdue | EventDetail, EventCreateForm, OrgPolicyEditor, OrgMemberList, Relationships, scheduling, briefing | `--color-destructive` (or existing `--destructive`) |
| `#dc2626` | red-600 | Error status | accounts, billing, provider-health, SyncStatus, ErrorRecovery, Policies | `--color-destructive-dark` |
| `#f59e0b` | amber-500 | Warning / pending | EventDetail, BriefingPanel, UpgradePromptBanner, briefing, scheduling | `--color-warning` (or existing `--warning`) |
| `#ca8a04` | yellow-600 | Caution status | accounts, billing, provider-health, SyncStatus | `--color-warning-dark` |
| `#eab308` | yellow-500 | Drifting / under-target | governance, relationships | `--color-caution` |
| `#8b5cf6` | violet-500 | Personal/client accent | relationships, briefing, UpgradePromptBanner, Reconnections | `--color-accent-personal` |
| `#6ee7b7` | emerald-300 | Success text (on dark bg) | ProviderHealth, Policies | `--text-success` |
| `#059669` | emerald-600 | Success border | ProviderHealth, Policies | `--border-success` |
| `#60a5fa` | blue-400 | Admin role text | OrgUsageDashboard, OrgMemberList, Policies | `--text-info` |
| `#fbbf24` | amber-400 | VIP accent text | Policies | `--text-warning` |
| `#34d399` | emerald-400 | Compliant accent text | Policies | `--text-success` |

### 1d. Component-specific inline hex colors

#### EventDetail.tsx (46 hex occurrences -- HIGHEST)
Most inline styles are for the slide-over panel (drawer) layout. Should be converted to a shared
`drawerStyles` object using CSS variables.

#### BriefingPanel.tsx (44 hex occurrences)
Same pattern as EventDetail -- slide-over panel styles. Nearly identical hex values.

#### UnifiedCalendar.tsx (40 hex occurrences)
Calendar grid styling. Day cells, headers, today highlight, event chips.

#### OrgPolicyEditor.tsx (32 hex occurrences)
Form/table styling with inline styles. Could use Tailwind tokens.

#### OrgMemberList.tsx (25 hex occurrences)
Table/dialog styling. Same surface palette as above.

#### EventCreateForm.tsx (19 hex occurrences)
Form drawer. Shares exact same palette as EventDetail.

#### OrgUsageDashboard.tsx (16 hex occurrences)
Table styling for org usage. Same surface/text palette.

#### UpgradePromptBanner.tsx (15 hex occurrences)
Banner component with status-specific colors.

---

## 2. Tailwind Palette Classes (122 occurrences)

These use Tailwind's default color palette directly instead of semantic tokens.

### 2a. Pages with Tailwind palette classes

#### Onboarding.tsx (38 occurrences) -- EXCEPTION: Light-themed page
Onboarding uses a **light background** (white cards, slate-200 borders, green-50 backgrounds).
This is intentionally different from the dark app theme. Needs its own token set or
an explicit "light mode" context.

Key classes: `text-slate-500`, `border-slate-200`, `bg-slate-50`, `text-green-600`,
`text-red-600`, `text-yellow-600`, `bg-green-50`, `bg-red-50`, `text-blue-600`,
`text-gray-700`, `text-[#1a1a2e]`

**Recommendation**: Create `--onboarding-*` token subset or use `data-theme="light"` scope.

#### Admin.tsx (17 occurrences)
- `text-slate-100` (headings) -> `text-foreground`
- `text-slate-400` (subtext) -> `text-muted-foreground`
- `text-slate-300` (nav link) -> `text-muted-foreground`
- `text-red-300/500` (error states) -> `text-destructive`
- `bg-red-500/10` (error button hover) -> `bg-destructive/10`
- `bg-blue-900/50 text-blue-400` (admin badge) -> `bg-primary/20 text-primary` or new `--badge-admin`
- `border-red-500` (error button border) -> `border-destructive`

#### Relationships.tsx (13 occurrences)
- `bg-emerald-950 text-emerald-300 border-emerald-600` -> `bg-success/10 text-success border-success`
- `bg-red-950 text-red-300 border-red-700` -> `bg-destructive/10 text-destructive border-destructive`
- `text-green-500` / `text-red-500` (scores) -> `text-success` / `text-destructive`
- `text-red-300` (warning text) -> `text-destructive`
- `border-violet-500 text-violet-500` (link button) -> new `--accent-personal` token
- `border-yellow-500 text-yellow-500` (CTA button) -> `border-warning text-warning`

#### Reconnections.tsx (8 occurrences)
- `border-violet-500` (timeline border) -> new `--accent-reconnection` token
- `text-slate-500` (metadata) -> `text-muted-foreground`
- `text-amber-500` (milestone date) -> `text-warning`

#### Accounts.tsx (7 occurrences)
- `bg-emerald-950 text-emerald-300 border-emerald-600` -> `bg-success/10 text-success border-success`
- `bg-red-950 text-red-300 border-red-600` -> `bg-destructive/10 text-destructive border-destructive`
- `border-blue-500 text-blue-500 hover:bg-blue-500/10` (action buttons) -> `border-primary text-primary hover:bg-primary/10`
- `accent-blue-500` (checkbox) -> `accent-primary`
- `text-yellow-400` (warning) -> `text-warning`

#### Login.tsx (5 occurrences)
- `text-slate-300` (labels) -> `text-muted-foreground`
- `text-slate-200` (input text) -> `text-foreground`
- `text-red-400` (error) -> `text-destructive`

#### Governance.tsx (4 occurrences)
- `bg-emerald-950 text-emerald-300 border-emerald-600` -> `bg-success/10 text-success border-success`
- `bg-red-950 text-red-300 border-red-700` -> `bg-destructive/10 text-destructive border-destructive`
- `bg-slate-600` (progress bar) -> `bg-muted`
- `text-emerald-400` (link) -> `text-success`

#### Scheduling.tsx (3 occurrences)
- `bg-emerald-950 text-emerald-300 border-emerald-600` -> `bg-success/10 text-success border-success`
- `bg-red-950 text-red-300 border-red-700` -> `bg-destructive/10 text-destructive border-destructive`
- `bg-green-600 hover:bg-green-700` (confirm button) -> `bg-success hover:bg-success/90`

#### Billing.tsx (3 occurrences)
- `bg-emerald-950 text-emerald-300 border-emerald-600` -> `bg-success/10 text-success border-success`
- `bg-red-950 text-red-300 border-red-700` -> `bg-destructive/10 text-destructive border-destructive`
- `bg-amber-950 text-amber-300 border-amber-600` (trial banner) -> `bg-warning/10 text-warning border-warning`

#### ProviderHealth.tsx (2 occurrences)
- `border-blue-500 text-blue-500 hover:bg-blue-500/10` (refresh button) -> `border-primary text-primary hover:bg-primary/10`

#### SyncStatus.tsx (1 occurrence)
- `text-red-300` (error count) -> `text-destructive`

#### Policies.tsx (1 occurrence)
- `bg-blue-950/15` (default column highlight) -> `bg-primary/10`

#### ErrorRecovery.tsx (1 occurrence)
- `border-orange-500 text-orange-500 hover:bg-orange-500/10` (retry button) -> `border-warning text-warning hover:bg-warning/10`

#### EventDetail.tsx component (3 Tailwind palette classes)
- Mirror status indicator uses `MIRROR_STATUS_COLORS` (hex in JS object, not classes)

---

## 3. Hardcoded rgba()/hsl() (4 occurrences)

| File | Line | Value | Recommended |
|------|------|-------|-------------|
| `components/EventDetail.tsx` | 576 | `rgba(0, 0, 0, 0.5)` (overlay) | `--overlay` token |
| `components/UnifiedCalendar.tsx` | 1043 | `rgba(30, 64, 175, 0.15)` (today highlight) | `--surface-today` token |
| `components/BriefingPanel.tsx` | 609 | `rgba(0, 0, 0, 0.6)` (overlay) | `--overlay` token |
| `components/EventCreateForm.tsx` | 320 | `rgba(0, 0, 0, 0.5)` (overlay) | `--overlay` token |

---

## 4. Library Color Constants (Centralized but still hardcoded hex)

These libraries already centralize colors into named constants/functions -- good pattern.
They need to be migrated from hex literals to CSS variable references.

### Phase C targets (lib/ files)

| File | Constants/Functions | Hex count | Priority |
|------|--------------------:|-----------|----------|
| `lib/relationships.ts` | `COLOR_GREEN/YELLOW/RED`, `BG_GREEN/YELLOW/RED`, `TIER_COLORS` | 11 | High |
| `lib/briefing.ts` | `CATEGORY_COLORS`, `DEFAULT_CATEGORY_COLOR`, `formatReputationScore`, `formatLastSeen` | 16 | High |
| `lib/scheduling.ts` | `statusColor()`, `statusBgColor()` | 10 | High |
| `lib/governance.ts` | `COLOR_COMPLIANT/UNDER/OVER`, `BG_COMPLIANT/UNDER/OVER` | 6 | Medium |
| `lib/provider-health.ts` | `PROVIDER_COLORS` (EXCEPTION), `BADGE_COLORS`, `badgeColor()` | 8 (4 non-exception) | Medium |
| `lib/billing.ts` | `statusColor()` colors map | 7 | Medium |
| `lib/accounts.ts` | `STATUS_COLORS` | 4 | Medium |
| `lib/onboarding.ts` | `PROVIDER_COLORS` (EXCEPTION) | 3 (all exception) | Skip |
| `lib/calendar-utils.ts` | `ACCOUNT_COLORS` (EXCEPTION), `FALLBACK_COLOR` | 13 (all exception) | Skip |

---

## 5. Recurring Pattern: Status Badge Trio

The pattern `bg-emerald-950 text-emerald-300 border-emerald-600` / `bg-red-950 text-red-300 border-red-700`
appears in 6 different page files:

- Governance.tsx
- Relationships.tsx (3 times)
- Accounts.tsx
- Scheduling.tsx
- Billing.tsx

**Recommendation**: Create a `StatusBadge` primitive or utility classes:
```css
.badge-success { @apply bg-success/10 text-success border-success; }
.badge-error   { @apply bg-destructive/10 text-destructive border-destructive; }
.badge-warning { @apply bg-warning/10 text-warning border-warning; }
```

---

## 6. Recurring Pattern: Action Button Colors

The pattern `border-blue-500 text-blue-500 hover:bg-blue-500/10` appears in:
- Accounts.tsx (3 times)
- ProviderHealth.tsx (1 time)

**Recommendation**: Use existing `Button variant="outline"` with primary token coloring.

---

## 7. Phase-by-Phase Fix Plan

### Phase B: Token Infrastructure (estimated: 12 new tokens)

Add to `index.css` `:root`:

```css
/* SURFACES (dark theme) */
--surface-panel:              222 47% 11%;    /* #0f172a slate-900 */
--surface-elevated:           217 33% 17%;    /* #1e293b slate-800 -- already defined in tailwind but not as CSS var */
--overlay:                    0 0% 0%;        /* used with alpha */

/* BORDERS */
--border-subtle:              215 25% 27%;    /* #334155 slate-700 */
--border-input:               215 20% 35%;    /* #475569 slate-600 */

/* TEXT */
--text-heading:               210 40% 98%;    /* #f1f5f9 slate-50 */
--text-secondary:             213 27% 84%;    /* #cbd5e1 slate-300 */
--text-disabled:              215 16% 47%;    /* #64748b slate-500 */

/* STATUS (supplement existing success/warning/destructive) */
--color-info:                 217 91% 60%;    /* #3b82f6 blue-500 */
--color-caution:              48 96% 53%;     /* #eab308 yellow-500 */

/* Subtle status backgrounds */
--surface-success-subtle:     155 100% 7%;    /* #052e16 */
--surface-destructive-subtle: 0 100% 14%;    /* #450a0a */
--surface-warning-subtle:     30 100% 8%;    /* #451a03 */
--surface-info-subtle:        213 50% 20%;   /* #1e3a5f */
```

Extend `tailwind.config.ts` with these new tokens.

### Phase C: Library Migration (8 files, ~75 hex values)

| File | Action |
|------|--------|
| `lib/relationships.ts` | Replace 11 hex constants with `var(--token)` references |
| `lib/briefing.ts` | Replace 16 hex values with token references |
| `lib/scheduling.ts` | Replace 10 hex values with token references |
| `lib/governance.ts` | Replace 6 hex constants with token references |
| `lib/provider-health.ts` | Replace 4 non-exception hex values |
| `lib/billing.ts` | Replace 7 hex values |
| `lib/accounts.ts` | Replace 4 hex values |
| `lib/onboarding.ts` | SKIP (brand colors exception) |
| `lib/calendar-utils.ts` | SKIP (dynamic per-account coloring exception) |

### Phase D: Component/Page Migration (16 files, ~400+ references)

#### Priority 1 -- High-traffic components (inline style heavy)
| File | Hex count | Tailwind classes | Total |
|------|-----------|------------------|-------|
| `components/EventDetail.tsx` | 46 | 3 | 49 |
| `components/BriefingPanel.tsx` | 44 | 0 | 44 |
| `components/UnifiedCalendar.tsx` | 40 | 0 | 40 |
| `components/OrgPolicyEditor.tsx` | 32 | 0 | 32 |
| `components/OrgMemberList.tsx` | 25 | 0 | 25 |
| `components/EventCreateForm.tsx` | 19 | 0 | 19 |

#### Priority 2 -- Secondary components
| File | Hex count | Tailwind classes | Total |
|------|-----------|------------------|-------|
| `components/OrgUsageDashboard.tsx` | 16 | 0 | 16 |
| `components/UpgradePromptBanner.tsx` | 15 | 0 | 15 |

#### Priority 3 -- Page files (Tailwind class heavy)
| File | Hex count | Tailwind classes | Total |
|------|-----------|------------------|-------|
| `pages/Onboarding.tsx` | 3 | 38 | 41 |
| `pages/Admin.tsx` | 0 | 17 | 17 |
| `pages/Relationships.tsx` | 9 | 13 | 22 |
| `pages/Reconnections.tsx` | 1 | 8 | 9 |
| `pages/Accounts.tsx` | 0 | 7 | 7 |
| `pages/Policies.tsx` | 11 | 1 | 12 |
| `pages/ProviderHealth.tsx` | 7 | 2 | 9 |
| `pages/Login.tsx` | 0 | 5 | 5 |
| `pages/Governance.tsx` | 3 | 4 | 7 |
| `pages/Scheduling.tsx` | 0 | 3 | 3 |
| `pages/Billing.tsx` | 1 | 3 | 4 |
| `pages/ErrorRecovery.tsx` | 2 | 1 | 3 |
| `pages/SyncStatus.tsx` | 3 | 1 | 4 |

---

## 8. Test Impact

When colors migrate from hardcoded hex to CSS variables, test assertions that check
exact hex values (e.g., `expect(statusColor("active")).toBe("#16a34a")`) will need updating.

Test files with hex assertions that will need updates:

| Test file | Assertions to update |
|-----------|---------------------|
| `lib/billing.test.ts` | 6 |
| `lib/scheduling.test.ts` | 10 |
| `lib/provider-health.test.ts` | 8 |
| `lib/briefing.test.ts` | 14 |
| `lib/relationships.test.ts` | (check) |
| `lib/governance.test.ts` | (check) |
| `pages/Accounts.test.tsx` | 4 |
| `pages/Onboarding.test.tsx` | 3 |
| `pages/Relationships.test.tsx` | 4 |
| `pages/Governance.test.tsx` | 3 |
| `components/EventDetail.test.tsx` | 8 |
| `e2e-relationships.test.tsx` | 3 |

**Strategy**: Tests should assert against the token name/variable rather than raw hex values.

---

## 9. Quick Wins (can fix immediately without new tokens)

These replacements use tokens that **already exist** in the design system:

| Current | Replacement | Where |
|---------|-------------|-------|
| `text-slate-100` | `text-foreground` | Admin.tsx headings |
| `text-slate-400` | `text-muted-foreground` | Admin.tsx, Reconnections.tsx |
| `text-slate-300` | `text-muted-foreground` | Login.tsx, Admin.tsx |
| `text-slate-200` | `text-foreground` | Login.tsx |
| `text-red-400` | `text-destructive` | Login.tsx |
| `bg-background` | Already correct | Many files |
| `border-border` | Already correct | Many files |

These 15-20 replacements require zero new token definitions.
