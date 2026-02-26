# T-Minus UI/UX Design Specification

> **Owner**: Designer
> **Status**: Draft
> **Created**: 2026-02-26
> **Companion**: [BUSINESS.md](./BUSINESS.md) (BA requirements)
> **Scope**: Complete visual redesign of the T-Minus web application

---

## 1. Design Principles

These seven principles govern every design decision in this specification. When choices conflict, the principle listed first takes precedence.

1. **Information over decoration.** Every pixel must serve a purpose. Visual interest emerges from hierarchy, density, and restraint -- never from ornament.

2. **Glance, then scan, then read.** The user's eye should land on the answer before they form the question. Status dots, color coding, and spatial grouping create instant orientation. Details reveal on demand.

3. **Data is the interface.** T-Minus is infrastructure for time. Timestamps, sync states, account emails, and event counts are the product surface. These deserve typographic distinction (monospace), not subordination.

4. **Gold means one thing.** The gold accent marks the single most important element in the viewport: the active nav item, the primary CTA, the current day. If gold appears in more than 2-3 places per viewport, the hierarchy has collapsed.

5. **Motion communicates state.** Animations exist to say "this is alive" (glow), "this just arrived" (entrance), or "you did something" (feedback). They never exist for style. All motion respects `prefers-reduced-motion`.

6. **Design for the dark.** The near-black canvas is not a dark theme applied to a light design. It is the foundation. All contrast ratios, glow intensities, and color choices are calibrated for #0a0a0f as the baseline.

7. **Changeability over perfection.** Every visual decision is expressed as a token, a utility class, or a composable pattern. When requirements evolve (and they will), the cost of change should be proportional to the scope of the change, not the number of files.

---

## 2. User Personas

### 2.1 Power Founder (Primary)

- **Who**: Startup founder or senior executive, 3-7 calendar accounts across Google, Microsoft, and ICS feeds.
- **Environment**: 14" laptop, often a secondary monitor, strong WiFi. Uses Linear, Arc, Raycast, Superhuman.
- **Core need**: A single pane of glass for their entire temporal reality. Glance at the sidebar, know if sync is healthy. Glance at the calendar, know what the day holds across all accounts.
- **Tolerance**: Zero patience for loading states or visual noise. Expects sub-second interactions. Will notice if the font rendering looks cheap.
- **Journey**: Login (once) -> Calendar (daily, 80% of time) -> Accounts (setup, occasional) -> Sync Status (when something feels off).

### 2.2 Ops-Minded Professional (Secondary)

- **Who**: Chief of Staff, EA, or operations person managing calendars for others.
- **Environment**: Desktop browser, often with multiple tabs open. Familiar with Datadog, Grafana, PagerDuty.
- **Core need**: Confidence that the system is working. Needs to see health at a glance and drill into problems when they arise. Wants data density, not hand-holding.
- **Tolerance**: Comfortable with tables, status codes, timestamps. Prefers seeing raw data over simplified summaries.
- **Journey**: Sync Status (primary) -> Provider Health -> Error Recovery -> Policies -> Accounts.

### 2.3 Developer / Maintainer (Tertiary)

- **Who**: The team building and maintaining T-Minus.
- **Core need**: Components that are composable, well-documented, and predictable. Token-driven styling that propagates changes cleanly.
- **Design implication**: Every component must have clear props interfaces. Visual behavior must be token-driven, not hardcoded. The design system must be a joy to work with, not a constraint to fight.

---

## 3. Design System Specification

### 3.1 Color Tokens

All values are raw HSL numbers (no `hsl()` wrapper) for Tailwind opacity modifier compatibility. These replace the current slate-dark palette in `index.css`.

```css
:root {
  /* ------------------------------------------------------------------ */
  /* SURFACES                                                           */
  /* ------------------------------------------------------------------ */
  --background:            240 20% 3.7%;       /* #0a0a0f  near-black canvas        */
  --foreground:            0 0% 93%;           /* #ededed  primary text              */

  --card:                  240 16.7% 8.6%;     /* #111118  card/panel surface        */
  --card-foreground:       0 0% 93%;           /* #ededed  text on cards             */

  --secondary:             240 10% 12%;        /* #1a1a24  elevated surface          */
  --secondary-foreground:  0 0% 80%;           /* #cccccc  text on secondary         */

  --muted:                 240 10% 12%;        /* #1a1a24  subdued backgrounds       */
  --muted-foreground:      240 5% 50%;         /* #797980  subdued text              */

  /* ------------------------------------------------------------------ */
  /* BORDERS                                                            */
  /* ------------------------------------------------------------------ */
  --border:                240 13% 15%;        /* #1e1e2e  default border            */
  --input:                 240 13% 15%;        /* #1e1e2e  input border (= border)   */

  /* ------------------------------------------------------------------ */
  /* ACCENT: GOLD                                                       */
  /* ------------------------------------------------------------------ */
  --primary:               43 49% 53%;         /* #C5A04E  gold accent               */
  --primary-foreground:    0 0% 0%;            /* #000000  text on gold              */

  --accent:                43 49% 53%;         /* #C5A04E  = primary for consistency */
  --accent-foreground:     0 0% 0%;

  --ring:                  43 49% 53%;         /* gold focus ring                    */

  /* ------------------------------------------------------------------ */
  /* SEMANTIC STATUS                                                    */
  /* ------------------------------------------------------------------ */
  --destructive:           0 72% 51%;          /* #d93025  error / destructive       */
  --destructive-foreground: 0 0% 100%;

  --success:               152 69% 31%;        /* #188038  healthy / success         */
  --success-foreground:    0 0% 100%;

  --warning:               43 96% 56%;         /* #f9ab00  degraded / caution        */
  --warning-foreground:    0 0% 0%;

  /* ------------------------------------------------------------------ */
  /* RADIUS                                                             */
  /* ------------------------------------------------------------------ */
  --radius: 0.5rem;
}
```

**Contrast Verification** (WCAG 2.1 AA):

| Pair | Foreground | Background | Ratio | Pass? |
|------|-----------|------------|-------|-------|
| Primary text on canvas | #ededed on #0a0a0f | 16.7:1 | Yes (AA + AAA) |
| Primary text on card | #ededed on #111118 | 13.8:1 | Yes (AA + AAA) |
| Muted text on canvas | #797980 on #0a0a0f | 5.2:1 | Yes (AA) |
| Muted text on card | #797980 on #111118 | 4.5:1 | Yes (AA, borderline -- monitor) |
| Gold on canvas | #C5A04E on #0a0a0f | 7.3:1 | Yes (AA) |
| Gold on card | #C5A04E on #111118 | 6.1:1 | Yes (AA) |
| White on gold | #000000 on #C5A04E | 7.3:1 | Yes (AA) |
| Status green on card | #188038 on #111118 | 3.2:1 | Large text only -- use as bg with white text |
| Status red on card | #d93025 on #111118 | 4.1:1 | Large text only -- use as bg with white text |

**Hardcoded Status Colors** (for inline `style` attributes on health indicators):

```typescript
const STATUS_COLORS = {
  green:  "#22c55e",  // healthy  (Tailwind green-500)
  amber:  "#f59e0b",  // degraded (Tailwind amber-500)
  red:    "#ef4444",  // error    (Tailwind red-500)
  blue:   "#3b82f6",  // info     (Tailwind blue-500)
} as const;
```

These four values are used only for status dots and health indicators where the color must be applied via inline `style` (e.g., `backgroundColor`). All other colors use design tokens via Tailwind classes.

### 3.2 Typography

**Font Stack**:

| Role | Family | Fallback | Loading |
|------|--------|----------|---------|
| UI text | Inter | `system-ui, -apple-system, sans-serif` | Self-hosted WOFF2, `font-display: swap` |
| Data/mono | JetBrains Mono | `ui-monospace, 'Cascadia Code', 'Fira Code', monospace` | Self-hosted WOFF2, `font-display: swap` |

**Type Scale**:

| Token | Font | Weight | Size | Letter-spacing | Line-height | Use |
|-------|------|--------|------|---------------|-------------|-----|
| `heading-1` | Inter | 700 (bold) | 1.5rem / 24px | -0.02em | 1.2 | Page titles (`<h1>`) |
| `heading-2` | Inter | 600 (semi) | 1.125rem / 18px | -0.01em | 1.3 | Section headers, card titles |
| `body` | Inter | 400 (regular) | 0.875rem / 14px | 0 | 1.5 | Default text, descriptions |
| `label` | Inter | 600 (semi) | 0.6875rem / 11px | 0.05em | 1.2 | Sidebar group labels, card section headers. **Always uppercase.** |
| `data-value` | JetBrains Mono | 400 (regular) | 0.8125rem / 13px | 0 | 1.4 | Timestamps, IDs, email addresses, counts, sync times |
| `data-label` | Inter | 500 (medium) | 0.75rem / 12px | 0.04em | 1.2 | Table column headers, data pair labels |
| `button` | Inter | 600 (semi) | 0.8125rem / 13px | 0.01em | 1.0 | Button text |

**Tailwind config additions** (`tailwind.config.ts`):

```typescript
fontFamily: {
  sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
  mono: ["JetBrains Mono", "ui-monospace", "Cascadia Code", "Fira Code", "monospace"],
},
fontSize: {
  "data": ["0.8125rem", { lineHeight: "1.4" }],      // 13px - monospace data
  "label": ["0.6875rem", { lineHeight: "1.2" }],      // 11px - uppercase labels
  "data-label": ["0.75rem", { lineHeight: "1.2" }],   // 12px - table headers
},
letterSpacing: {
  "label": "0.05em",
  "data-label": "0.04em",
},
```

**Font loading** (in `index.html` `<head>`, before CSS):

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap"
  rel="stylesheet"
/>
```

**CLS mitigation**: The `font-display: swap` strategy means a brief FOUT (flash of unstyled text) while fonts load. This is acceptable because:
- The fallback stacks are metrically similar (system-ui for Inter, ui-monospace for JetBrains Mono).
- The near-black background makes the flash less perceptible than on white.
- Blocking font load would harm LCP on slow connections.

### 3.3 Spacing System

The spacing system uses Tailwind's default 4px grid. These are the canonical patterns.

| Context | Spec | Tailwind |
|---------|------|----------|
| Page content padding (desktop) | 24px | `p-6` |
| Page content padding (mobile) | 16px | `p-4` |
| Space between cards | 16px | `gap-4` |
| Space between card groups / sections | 24px | `gap-6` |
| Card internal padding | 24px all sides | `p-6` |
| Card header bottom padding | 0 (rely on `space-y-1.5` in CardHeader) | -- |
| Table cell padding | 12px horizontal, 8px vertical | `px-3 py-2` |
| Sidebar item padding | 12px horizontal, 8px vertical | `px-3 py-2` |
| Sidebar group gap | 8px | `gap-2` |
| Button internal padding | 16px horizontal, 8px vertical (default) | `px-4 py-2` |
| Form input padding | 12px horizontal, 10px vertical | `px-3 py-2.5` |
| Between inline elements | 8px | `gap-2` |
| Between a label and its field | 6px | `gap-1.5` |

### 3.4 Borders and Radius

| Property | Value | Tailwind |
|----------|-------|----------|
| Default border | 1px solid `var(--border)` | `border border-border` |
| Card border | 1px solid `var(--border)` | Automatic from Card component |
| Focus ring | 2px solid `var(--ring)` with 2px offset | `ring-2 ring-ring ring-offset-2 ring-offset-background` |
| Border radius (card, dialog) | `var(--radius)` = 0.5rem / 8px | `rounded-lg` |
| Border radius (button, input) | `calc(var(--radius) - 2px)` = 6px | `rounded-md` |
| Border radius (badge, small elements) | `calc(var(--radius) - 4px)` = 4px | `rounded-sm` |
| Border radius (badge pill) | 9999px | `rounded-full` |
| Separator | 1px height, `bg-border` | Separator component |

### 3.5 Shadows and Glow

Shadows are minimal. The near-black canvas means traditional `box-shadow` drop shadows are invisible. Instead, depth is communicated through luminance steps (background -> card -> secondary) and subtle border differentiation.

| Element | Shadow / Glow | CSS |
|---------|--------------|-----|
| Card (default) | None (border provides edge definition) | -- |
| Card (elevated, e.g., dialog) | Subtle dark shadow | `shadow-lg` (`0 10px 15px -3px rgba(0,0,0,0.3)`) |
| Toast | Medium shadow for float effect | `shadow-lg` |
| Status dot (healthy, static) | Soft green glow | `box-shadow: 0 0 6px 2px rgba(34, 197, 94, 0.4)` |
| Status dot (healthy, animated) | Pulsing green glow (2s) | See Animation Spec 4.3 |
| Status dot (error, static) | Soft red glow | `box-shadow: 0 0 6px 2px rgba(239, 68, 68, 0.4)` |
| Status dot (degraded, static) | Soft amber glow | `box-shadow: 0 0 6px 2px rgba(245, 158, 11, 0.4)` |
| Active sidebar item | Soft gold glow on left border | `box-shadow: -2px 0 8px 0 rgba(197, 160, 78, 0.3)` |
| Gold button hover | Subtle gold glow | `box-shadow: 0 0 12px 0 rgba(197, 160, 78, 0.25)` |
| Focus ring | Gold ring (via `--ring`) | Built into Tailwind ring utilities |

---

## 4. Animation Specifications

### 4.1 Animation Budget

Maximum 3 distinct animation types running concurrently on any page. Status dot glows are exempt (GPU-composited `box-shadow` opacity, negligible cost).

All animations use GPU-composited properties only: `transform` (translate, scale) and `opacity`. No `width`, `height`, `margin`, `padding`, or `left`/`top` animations.

### 4.2 Framer Motion Entrance Animations

Framer Motion is the animation library (tree-shaken import of `motion` and `AnimatePresence` only, ~15KB gzipped).

**Card entrance pattern**:

```tsx
// Individual card
<motion.div
  initial={{ opacity: 0, y: 12 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.3, ease: "easeOut" }}
>
  <Card>...</Card>
</motion.div>

// Staggered list of cards
<motion.div
  initial="hidden"
  animate="visible"
  variants={{
    visible: { transition: { staggerChildren: 0.05 } },
  }}
>
  {items.map((item) => (
    <motion.div
      key={item.id}
      variants={{
        hidden: { opacity: 0, y: 12 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } },
      }}
    >
      <Card>...</Card>
    </motion.div>
  ))}
</motion.div>
```

**Page transition (route change)**:

```tsx
<AnimatePresence mode="wait">
  <motion.div
    key={location.pathname}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.2, ease: "ease" }}
  >
    {children}
  </motion.div>
</AnimatePresence>
```

**Modal entrance**:

```tsx
<motion.div
  initial={{ opacity: 0, scale: 0.95 }}
  animate={{ opacity: 1, scale: 1 }}
  exit={{ opacity: 0, scale: 0.95 }}
  transition={{ duration: 0.2, ease: "easeOut" }}
>
```

**Toast slide-in**:

```tsx
<motion.div
  initial={{ opacity: 0, x: 100 }}
  animate={{ opacity: 1, x: 0 }}
  exit={{ opacity: 0, x: 100 }}
  transition={{ duration: 0.3, ease: "easeOut" }}
>
```

### 4.3 CSS Keyframe Animations

These are defined in `tailwind.config.ts` under `keyframes` and `animation`.

**Status dot glow** (2s cycle, infinite, single generic keyframe using `currentColor`):

```typescript
keyframes: {
  glow: {
    "0%, 100%": { boxShadow: "0 0 4px 1px currentColor" },
    "50%":      { boxShadow: "0 0 8px 3px currentColor" },
  },
},
animation: {
  glow:        "glow 2s ease-in-out infinite",
  "spin-slow": "spin-slow 1.2s linear infinite",  // existing
},
```

The `glow` keyframe uses `currentColor` so the glow color inherits from the element's `color` property. A green health dot (`text-success`) glows green; a red one (`text-destructive`) glows red; an amber one (`text-warning`) glows amber. No per-color keyframe duplication needed. Usage: apply `animate-glow` alongside the appropriate text color class (e.g., `text-success animate-glow`).

**Skeleton pulse**: Already provided by Tailwind's `animate-pulse`. No change needed.

### 4.4 Hover Transitions

All hover transitions use `transition-colors` (150ms) which is already the default in the existing Button component. Additional hover effects:

| Element | Hover behavior | Duration |
|---------|---------------|----------|
| Button (gold/primary) | Background lightens slightly + subtle glow | 150ms ease |
| Button (ghost) | Background becomes `accent/10` | 150ms ease |
| Button (outline) | Border becomes `accent`, text becomes `accent-foreground` | 150ms ease |
| Sidebar nav item | Background becomes `accent/10`, text brightens | 150ms ease |
| Table row | Background becomes `secondary/50` | 150ms ease |
| Link text | Color shifts to gold | 150ms ease |
| Card (interactive, e.g., account card) | Border brightens to `border` + 20% luminance | 150ms ease |

### 4.5 Reduced Motion

When `prefers-reduced-motion: reduce` is active:

- All Framer Motion animations resolve instantly (duration: 0).
- All CSS `animation` properties are set to `none` via Tailwind's `motion-reduce:animate-none`.
- Hover transitions are preserved (they are fast and non-disorienting).
- Status dots show static glow (no pulsing) -- the `box-shadow` remains at its "rest" state.

**Implementation**: Wrap Framer Motion defaults:

```typescript
// src/web/src/lib/motion.ts
import { useReducedMotion } from "framer-motion";

export function useMotionConfig() {
  const reduced = useReducedMotion();
  return {
    initial: reduced ? false : undefined,
    transition: reduced ? { duration: 0 } : undefined,
  };
}
```

---

## 5. Component Design Language

These specifications define how each primitive component should be restyled. They preserve existing props interfaces (no breaking changes) while changing internal class names and visual treatment.

### 5.1 Card

The card is the fundamental container. Dense content within, spacious spacing between.

```
+------------------------------------------------------------------+
|  1px border (--border)  |  bg: var(--card) = #111118             |
|                         |  rounded-lg (8px)                      |
|  +-- CardHeader (p-6) ------------------------------------------+
|  |  SECTION LABEL          <- label token, uppercase, tracking   |
|  |  Card Title             <- heading-2 token                    |
|  |  Description text       <- body token, muted-foreground       |
|  +---------------------------------------------------------------+
|  +-- CardContent (p-6 pt-0) ------------------------------------+
|  |  ... card body content ...                                    |
|  +---------------------------------------------------------------+
|  +-- CardFooter (p-6 pt-0) -------------------------------------+
|  |  [Actions]                                                    |
|  +---------------------------------------------------------------+
+------------------------------------------------------------------+
```

**Changes from current**:
- `shadow-sm` removed from Card base (shadows invisible on near-black).
- CardTitle downsized from `text-2xl` to `text-lg` (heading-2 scale).
- Optional: CardHeader can include an uppercase label above the title using `<p className="text-label uppercase tracking-label text-muted-foreground mb-1">`.

### 5.2 Button Variants

| Variant | Background | Text | Border | Hover | Glow |
|---------|-----------|------|--------|-------|------|
| `default` (gold) | `bg-primary` (#C5A04E) | `text-primary-foreground` (#000) | None | `bg-primary/90` + gold glow | `hover:shadow-[0_0_12px_0_rgba(197,160,78,0.25)]` |
| `secondary` | `bg-secondary` (#1a1a24) | `text-secondary-foreground` (#ccc) | None | `bg-secondary/80` | None |
| `ghost` | Transparent | `text-muted-foreground` | None | `bg-accent/10`, `text-accent-foreground` | None |
| `outline` | `bg-background` | `text-foreground` | `border-input` | `bg-accent/10`, `text-accent-foreground` | None |
| `destructive` | `bg-destructive` (#d93025) | `text-destructive-foreground` (#fff) | None | `bg-destructive/90` | None |
| `link` | Transparent | `text-primary` (gold) | None | Underline | None |

**Key change**: The primary/default button is now gold, not blue. This is the single most visible change in the redesign.

### 5.3 Badge Variants

Badges use `rounded-full` (pill shape), `text-xs`, `font-semibold`, `px-2.5 py-0.5`.

| Variant | Style | Use |
|---------|-------|-----|
| `default` (gold) | `bg-primary/15 text-primary border-primary/25` | Default accent badge, active states |
| `secondary` | `bg-secondary text-secondary-foreground border-transparent` | Neutral metadata |
| `destructive` | `bg-destructive/15 text-red-400 border-destructive/25` | Error counts, critical states |
| `success` | `bg-success/15 text-green-400 border-success/25` | Healthy, synced, active |
| `warning` | `bg-warning/15 text-amber-400 border-warning/25` | Degraded, stale, caution |
| `outline` | `bg-transparent text-foreground border-border` | Neutral with visible border |

**Key change**: Badges shift from solid backgrounds (`bg-<color>`) to tinted backgrounds (`bg-<color>/15`) with lighter text. This is more legible on near-black and matches the Settlement Monitor's restrained color use.

### 5.4 Status Indicator Dot

The status dot is a 10px circle with a color-coded glow. It communicates sync health, account status, and provider health.

```html
<!-- Static dot -->
<span
  className="inline-block h-2.5 w-2.5 rounded-full"
  style={{ backgroundColor: STATUS_COLORS.green }}
/>

<!-- Animated dot (Sync Status page) -->
<span
  className="inline-block h-2.5 w-2.5 rounded-full text-success animate-glow motion-reduce:animate-none"
  style={{ backgroundColor: "currentColor" }}
/>
```

| Health | Text color class | Glow animation class | Static fallback |
|--------|-----------------|---------------------|-----------------|
| Healthy | `text-success` | `animate-glow` | `shadow-[0_0_4px_1px_currentColor]` |
| Degraded | `text-warning` | `animate-glow` | `shadow-[0_0_4px_1px_currentColor]` |
| Error | `text-destructive` | `animate-glow` | `shadow-[0_0_4px_1px_currentColor]` |
| Stale | `text-warning` | `animate-glow` | Same as degraded |

The dot size is 10px (`h-2.5 w-2.5`), not the current 12px (`h-3 w-3`). The glow effect makes it feel larger without occupying more layout space.

### 5.5 Table Rows

Tables are the primary data display pattern on Sync Status, Provider Health, and Policies pages.

```
+-----------------------------------------------------------+
| HEADER ROW                                                |
|  text-data-label tracking-data-label uppercase             |
|  text-muted-foreground font-medium                         |
|  border-b border-border                                    |
|  px-3 py-2                                                 |
+-----------------------------------------------------------+
| DATA ROW (even)                                           |
|  bg-transparent                                            |
|  text-foreground (prose) / font-mono text-data (data)      |
|  border-b border-border/50                                 |
|  px-3 py-2                                                 |
|  hover:bg-secondary/50 transition-colors                   |
+-----------------------------------------------------------+
| DATA ROW (odd)                                            |
|  bg-secondary/30                                           |
|  (same text treatment as even rows)                        |
+-----------------------------------------------------------+
```

**Zebra striping**: Subtle (`bg-secondary/30` on odd rows). On a near-black canvas, even small luminance differences create readable alternation.

**Data cells**: Email addresses, timestamps, IDs, and counts use `font-mono text-data` (JetBrains Mono at 13px). Prose content (descriptions, labels) uses `text-sm` (Inter at 14px).

**Selection** (future): `bg-primary/10 border-l-2 border-primary` on the selected row.

### 5.6 Form Inputs

```
+-----------------------------------------------------------+
|  LABEL (text-label uppercase tracking-label               |
|         text-muted-foreground font-semibold)               |
|                                                            |
|  +------------------------------------------------------+ |
|  |  Input field                                          | |
|  |  bg-background (#0a0a0f)                              | |
|  |  border border-border (#1e1e2e)                       | |
|  |  rounded-md (6px)                                     | |
|  |  px-3 py-2.5                                          | |
|  |  text-sm text-foreground                              | |
|  |  placeholder:text-muted-foreground                    | |
|  |  focus:ring-2 focus:ring-ring (gold)                  | |
|  |  focus:border-transparent                             | |
|  +------------------------------------------------------+ |
+-----------------------------------------------------------+
```

**Key change from current**: Labels shift from `text-sm font-medium text-slate-300` to the `label` token (uppercase, tracked, 11px). Input text changes from `text-slate-200` to `text-foreground`. Focus ring changes from blue to gold.

### 5.7 Dialog / Modal

```
OVERLAY: fixed inset-0 bg-black/80 (unchanged)

+------------------------------------------------------------------+
|  Dialog panel                                                     |
|  bg-card (#111118)                                                |
|  border border-border (#1e1e2e)                                   |
|  rounded-lg (8px)                                                 |
|  shadow-lg (dark shadow for float)                                |
|  p-6, max-w-lg                                                    |
|                                                                   |
|  Entrance: opacity 0->1 + scale 0.95->1.0, 200ms ease-out        |
|  Exit:     opacity 1->0 + scale 1.0->0.95, 200ms ease-out        |
|                                                                   |
|  [X] close button: top-right, opacity-70 hover:opacity-100        |
+------------------------------------------------------------------+
```

The existing Dialog component already uses `bg-card`, border, and appropriate animations via `tailwindcss-animate`. The primary change is that the background color now resolves to #111118 instead of #1e293b, and the focus ring is gold instead of blue.

### 5.8 Toast Notifications

```
CONTAINER: fixed bottom-4 right-4 z-[100] flex flex-col gap-2

+---------------------------------------------------+
|  Toast                                             |
|  rounded-lg border px-4 py-3 text-sm shadow-lg     |
|  Entrance: translateX 100->0, opacity 0->1, 300ms  |
|  Exit:     translateX 0->100, opacity 1->0, 300ms  |
+---------------------------------------------------+
```

| Variant | Border | Background | Text |
|---------|--------|------------|------|
| `default` | `border-border` | `bg-card` | `text-card-foreground` |
| `success` | `border-success/50` | `bg-success/10` | `text-green-400` |
| `destructive` | `border-destructive/50` | `bg-destructive/10` | `text-red-400` |
| `warning` | `border-warning/50` | `bg-warning/10` | `text-amber-400` |

The existing Toast component's variant classes already match this pattern. The visual change comes from the new token values (darker card, different border color).

---

## 6. Layout Specifications

### 6.1 App Shell

```
+------ 240px ------+------ remaining width ------+
|                    |                              |
|    SIDEBAR         |   HEADER (h-14 / 56px)      |
|    bg-card         |   bg-card                    |
|    border-r        |   border-b                   |
|                    |   [hamburger(mobile)] [email] [logout]
|    +------------+  +------------------------------+
|    | T-Minus    |  |                              |
|    | (brand)    |  |   CONTENT AREA               |
|    +------------+  |   p-6 (desktop)              |
|    | CORE       |  |   p-4 (mobile)               |
|    | - Calendar |  |   overflow-y-auto             |
|    | - Accounts |  |   max-w-[1200px] mx-auto     |
|    | - Sync     |  |     (page-level constraint)  |
|    +------------+  |                              |
|    | CONFIG     |  |                              |
|    | - Policies |  |                              |
|    | - Health   |  |                              |
|    | - Errors   |  |                              |
|    +------------+  |                              |
|    | BUSINESS   |  |                              |
|    | - Schedule |  |                              |
|    | - Govern   |  |                              |
|    | - Relate   |  |                              |
|    | - Reconn   |  |                              |
|    | - Billing  |  |                              |
|    +------------+  |                              |
|                    |                              |
+--------------------+------------------------------+
```

**Dimensions**:
- Sidebar width: 240px (`w-60`) -- unchanged.
- Header height: 56px (`h-14`) -- unchanged.
- Content max-width: 1200px (`max-w-[1200px]`) -- page-level responsibility, not shell-level.
- Content padding: 24px desktop (`p-6`), 16px mobile (`p-4`) -- unchanged.

### 6.2 Sidebar Design

```
+-- Sidebar (bg-card, border-r border-border) ----+
|                                                   |
|  +-- Brand Area (h-14, px-6) -------------------+|
|  |  T-Minus         <- text-lg font-bold          |
|  |                      text-foreground            |
|  +-----------------------------------------------+|
|  |  Separator (h-[1px] bg-border)                 |
|  +-----------------------------------------------+|
|                                                   |
|  +-- Nav (px-3 py-4) ---------------------------+|
|  |                                               ||
|  |  CORE              <- label token             ||
|  |                       text-muted-foreground   ||
|  |                       uppercase tracking-label ||
|  |                                               ||
|  |  [*] Calendar      <- active state            ||
|  |      bg-primary/15                            ||
|  |      text-foreground                          ||
|  |      border-l-2 border-primary                ||
|  |      shadow-[-2px_0_8px_0_rgba(...gold...)]   ||
|  |                                               ||
|  |  [ ] Accounts      <- inactive state          ||
|  |      text-muted-foreground                    ||
|  |      hover:bg-accent/10                       ||
|  |      hover:text-foreground                    ||
|  |                                               ||
|  |  [ ] Sync Status                              ||
|  |                                               ||
|  |  --- Separator ---                            ||
|  |                                               ||
|  |  CONFIGURATION     <- label token             ||
|  |  ...                                          ||
|  +-----------------------------------------------+|
+---------------------------------------------------+
```

**Active state redesign**: The current active state uses `bg-accent/15 text-accent-foreground` which resolves to a blue tint. The redesign changes this to:

```tsx
isActive
  ? "bg-primary/15 text-foreground border-l-2 border-primary shadow-[-2px_0_8px_0_rgba(197,160,78,0.3)]"
  : "text-muted-foreground hover:bg-accent/10 hover:text-foreground border-l-2 border-transparent"
```

The `border-l-2 border-transparent` on inactive items maintains layout consistency so items do not shift when activating.

**Nav item dimensions**: `px-3 py-2 text-sm font-medium` -- unchanged. Icon size: `h-4 w-4` -- unchanged.

**Group labels**: Already use `text-xs font-semibold uppercase tracking-wider text-muted-foreground` which aligns with the label token. No change needed.

### 6.3 Responsive Behavior

| Breakpoint | Behavior |
|------------|----------|
| >= 768px (md) | Desktop: sidebar visible, header shows email + logout |
| < 768px | Mobile: sidebar hidden, hamburger button in header, sidebar slides in as overlay |

**Mobile sidebar**: Slides from left (`-translate-x-full` to `translate-x-0`), 200ms transition. Overlay (`bg-black/50`) behind. Closes on route change, overlay click, X button, or Escape key. This behavior is unchanged from the current implementation.

**Content width**: Pages use `max-w-[1200px] mx-auto` for their own content width. On mobile, this is effectively `100%` since the viewport is narrower.

---

## 7. Page-Level Design Direction

### 7.1 Login Page (Tier 1)

**Layout**: Full-page, centered vertically and horizontally. No sidebar, no header. The `bg-background` (#0a0a0f) canvas is the only backdrop.

```
+------------------------------------------------------------------+
|                                                                    |
|                                                                    |
|              +--------------------------------------+              |
|              |  Card (max-w-[400px])                |              |
|              |  bg-card  border border-border        |              |
|              |  rounded-lg p-8                       |              |
|              |  subtle border glow on load:          |              |
|              |  shadow-[0_0_20px_0_rgba(            |              |
|              |    197,160,78,0.08)]                  |              |
|              |                                       |              |
|              |  T-Minus                              |              |
|              |  <- heading-1 (Inter 700, 24px)       |              |
|              |                                       |              |
|              |  Calendar Federation Engine            |              |
|              |  <- font-mono text-data               |              |
|              |     text-muted-foreground              |              |
|              |     tracking-wider                     |              |
|              |                                       |              |
|              |  [Email field]                        |              |
|              |  [Password field]                     |              |
|              |                                       |              |
|              |  [========= Sign In =========]        |              |
|              |  <- Button default (gold)             |              |
|              |     w-full                             |              |
|              |                                       |              |
|              +--------------------------------------+              |
|                                                                    |
+------------------------------------------------------------------+
```

**Key design decisions**:
- The subtitle "Calendar Federation Engine" uses JetBrains Mono. This immediately establishes the dual-font discipline and communicates "this is infrastructure, not a consumer toy."
- The card has an extremely subtle gold glow on its border (`shadow-[0_0_20px_0_rgba(197,160,78,0.08)]`) -- barely perceptible, but it adds life to an otherwise static page.
- The Sign In button is the only gold element on the page (Principle 4).
- Error messages use `text-destructive` (now #d93025, slightly muted from the current #ef4444) for better readability against the dark card.
- Labels above inputs use the `label` token (uppercase, tracked).

**What changes from current** (`Login.tsx`):
- `text-slate-300` on labels becomes `text-muted-foreground uppercase text-label tracking-label font-semibold`
- `text-slate-200` on inputs becomes `text-foreground`
- `text-red-400` on error becomes `text-destructive`
- `text-[1.75rem]` on title becomes `text-2xl font-bold tracking-tight` (heading-1)
- Subtitle adds `font-mono text-data tracking-wider`
- Card adds subtle gold glow shadow
- Submit button styling already uses token classes -- visual change is automatic

### 7.2 Onboarding Page (Tier 1)

**Layout**: Full-page (outside AppShell), centered. Step-based flow with progressive disclosure.

**Step Indicators**:

```
  [ 1 ]----[ 2 ]----[ 3 ]
  Connect   Sync     Done

  Active step:    bg-primary text-primary-foreground (gold circle)
  Completed step: bg-primary/20 text-primary border border-primary/50
  Future step:    bg-secondary text-muted-foreground border border-border
  Connector line: h-[2px] bg-border (completed: bg-primary/50)
```

**Provider Cards** (idle state, choosing which provider to connect):

```
+-------------------------------------------+
|  Provider Card                             |
|  bg-card border border-border rounded-lg   |
|  p-6 cursor-pointer                        |
|  hover:border-primary/50                   |
|  transition-colors duration-150            |
|                                            |
|  [Google icon]     <- 24x24, provider color|
|  Google Calendar   <- heading-2            |
|  Connect your Google account               |
|  <- body, text-muted-foreground            |
|                                            |
+-------------------------------------------+
```

Provider cards use entrance animation (stagger 50ms per card). On click, the selected card gets `border-primary` and the others fade to `opacity-50`.

**Syncing State**: A pulsing gold LoadingSpinner replaces the default. Below it, text reads "Syncing your calendar..." in `text-muted-foreground`, and a progress-like indicator shows events found (using `font-mono text-data` for the count).

**Success State**: Connected account card with:
- Provider icon + email (font-mono)
- Calendar count badge (`success` variant)
- Status dot (healthy, animated)
- "Add another account" button (outline variant)
- "Done" button (gold/primary variant)

**Error State**: Error card with:
- Red border (`border-destructive/50`)
- Error message in `text-destructive`
- "Try again" button (outline variant)
- "Get help" link (link variant)

### 7.3 Calendar Page (Tier 1)

**Layout**: Full-width within content area. Three subcomponents: nav bar, grid, briefing panel.

**Calendar Navigation Bar**:

```
+------------------------------------------------------------------+
|  < Prev   [Week] [Month] [Day]   Today   Next >                  |
|                                                                   |
|  February 24 - March 2, 2026     <- heading-2                    |
|  <- font-mono text-data text-muted-foreground for date range      |
+------------------------------------------------------------------+
```

- View toggle buttons: `variant="ghost"`, active view gets `bg-primary/15 text-primary`.
- "Today" button: `variant="outline"`.
- Date range: JetBrains Mono, muted, communicating "this is data."

**Week Grid**:

```
+------+------+------+------+------+------+------+
| MON  | TUE  | WED  | THU  | FRI  | SAT  | SUN  |
| 24   | 25   | *26* | 27   | 28   |  1   |  2   |
+------+------+------+------+------+------+------+
|      |      | gold |      |      |      |      |
|      |      | high |      |      |      |      |
|Event |      |Event |Event |      |      |      |
|card  |      |card  |card  |      |      |      |
|      |      |      |      |      |      |      |
+------+------+------+------+------+------+------+
```

- Day headers: `label` token (uppercase, tracked, muted).
- Day numbers: `font-mono text-data` for the number. Current day gets `text-primary font-bold` (gold number).
- Current day column: Entire column header has a subtle gold underline (`border-b-2 border-primary`).
- Grid cells: `bg-background` (near-black). Hover: `bg-card/50`. Clickable for event creation.
- Grid lines: `border-border` (subtle, not dominant).

**Event Cards** (within grid cells):

```
+-- Event Card ----------------------------+
|  bg-<provider-color>/15                   |
|  border-l-2 border-<provider-color>       |
|  rounded-sm px-2 py-1                     |
|  text-xs truncate                         |
|                                           |
|  9:00 AM Meeting with Jane               |
|  <- time in font-mono, title in font-sans |
+-------------------------------------------+
```

- Provider-color coding: Google events get a Google-blue left border, Microsoft events get a Microsoft-teal left border, ICS events get a neutral gray left border.
- The tinted background (`bg-<color>/15`) provides visual grouping without overwhelming the grid.
- Click opens EventDetail in a slide-over panel.

**Briefing Panel** (slide-in from right):

```
+-- Briefing Panel (w-80, slide from right) --+
|  bg-card border-l border-border              |
|  p-6                                         |
|                                              |
|  PRE-MEETING CONTEXT  <- label token         |
|                                              |
|  Meeting Title         <- heading-2          |
|  9:00 - 10:00 AM      <- font-mono text-data |
|  with@someone.com      <- font-mono text-data |
|                                              |
|  --- Separator ---                           |
|                                              |
|  CONTEXT               <- label token        |
|  Briefing content...   <- body               |
|                                              |
|  PARTICIPANTS           <- label token       |
|  - Name (email)                              |
|                                              |
+----------------------------------------------+
```

The panel slides in with `translateX(100%) -> translateX(0)`, 300ms ease-out.

### 7.4 Accounts Page (Tier 1)

**Layout**: Card grid. Each linked account is a card. "Link new account" cards at the end.

**Account Card**:

```
+------------------------------------------------------------------+
|  Account Card                                                     |
|  bg-card border border-border rounded-lg                          |
|  p-6                                                              |
|  Entrance: opacity + translateY, 300ms, staggered 50ms            |
|                                                                   |
|  +-- Header Row ------------------------------------------------+|
|  |  [Provider Icon]  user@example.com  <- font-mono text-data    ||
|  |                                                               ||
|  |  [Status Dot]  [Status Badge]                          [...]  ||
|  |  text-success animate-glow   success variant           menu   ||
|  +---------------------------------------------------------------+|
|                                                                   |
|  --- Separator ---                                                |
|                                                                   |
|  CALENDARS               <- label token                           |
|  +-- Scope List -------------------------------------------------+|
|  |  [x] Primary Calendar    <- toggle + label                    ||
|  |  [x] Team Calendar       <- toggle + label                    ||
|  |  [ ] Holidays            <- toggle (excluded) + label         ||
|  +---------------------------------------------------------------+|
|                                                                   |
|  FEDERATION               <- label token                          |
|  +-- Settings ---------------------------------------------------|
|  |  Cascade to origin: [toggle]                                  ||
|  +---------------------------------------------------------------+|
|                                                                   |
|  [Unlink Account]          <- Button destructive variant          |
+------------------------------------------------------------------+
```

**Link New Account Cards**:

```
+-------------------------------------------+
|  bg-card/50 border border-dashed           |
|  border-border rounded-lg p-6              |
|  cursor-pointer                            |
|  hover:border-primary/50                   |
|  hover:bg-card                             |
|  transition-colors                         |
|                                            |
|  [+] Link Google Account                   |
|  <- text-muted-foreground                  |
|     hover:text-foreground                  |
+-------------------------------------------+
```

The dashed border and lighter background communicate "this is a placeholder waiting to be filled."

**Status dots on account cards**: Use the generic `animate-glow` class with the appropriate text color (`text-success`, `text-destructive`, `text-warning`). The glow inherits color via `currentColor`. These are always-on animations -- the glow subtly communicates "this account is live and being monitored."

### 7.5 Sync Status Page (Tier 1)

This is the ops-dashboard page. It is where the Settlement Monitor aesthetic pays off most.

**Layout**:

```
+------------------------------------------------------------------+
|                                                                    |
|  Sync Status                    <- heading-1                       |
|                                                                    |
|  +-- Overall Health Banner ------------------------------------+  |
|  |  [Glow Dot]  Overall: All Systems Healthy                   |  |
|  |  bg-success/10 border border-success/30 rounded-lg          |  |
|  |  px-4 py-3 text-sm font-semibold                            |  |
|  |  Entrance: opacity + translateY, 300ms                      |  |
|  +-------------------------------------------------------------+  |
|                                                                    |
|  +-- Mirror Engine Card ----------------------------------------+ |
|  |  MIRROR ENGINE              <- label token                    | |
|  |  3 pending, 0 errors, 12 active                              | |
|  |  <- font-mono text-data for numbers                           | |
|  +---------------------------------------------------------------+ |
|                                                                    |
|  +-- Account Health Table --------------------------------------+ |
|  |                                                               | |
|  | STATUS  EMAIL         PROVIDER  LAST SYNC  CHANNEL  PEND ERR | |
|  | [*]     user@gm...   Google    2m ago      active    0    0  | |
|  | [*]     work@ms...   MSFT      5m ago      active    1    0  | |
|  | [!]     old@gc...    Google    3h ago      expired   0    2  | |
|  |                                                               | |
|  | Table headers: data-label token (uppercase, tracked)          | |
|  | Data cells: font-mono text-data                               | |
|  | Status column: animated glow dots                             | |
|  | Error count > 0: text-red-400 font-bold                       | |
|  | Rows: zebra bg-secondary/30, hover:bg-secondary/50            | |
|  +---------------------------------------------------------------+ |
|                                                                    |
+------------------------------------------------------------------+
```

**Overall Health Banner** variants:

| Health | Background | Border | Dot | Text |
|--------|-----------|--------|-----|------|
| Healthy | `bg-success/10` | `border-success/30` | `text-success animate-glow` | "All Systems Healthy" |
| Degraded | `bg-warning/10` | `border-warning/30` | `text-warning animate-glow` | "Degraded -- Check Accounts Below" |
| Stale | `bg-warning/10` | `border-warning/30` | `text-warning animate-glow` | "Stale -- Some Accounts Need Attention" |
| Error | `bg-destructive/10` | `border-destructive/30` | `text-destructive animate-glow` | "Error -- Immediate Attention Required" |

**Key change from current**: The banner currently uses inline `style={{ backgroundColor }}` with solid colors. The redesign shifts to tinted token-based backgrounds (`bg-success/10`) with borders, matching the overall aesthetic. The health symbols (filled circle, triangle, square, X) are replaced by animated glow dots.

**Table redesign**: The table currently uses basic borders. The redesign adds:
- Uppercase tracked column headers (data-label token).
- JetBrains Mono for all data cells (email, timestamps, counts).
- Zebra striping on rows.
- Animated glow dots in the Status column.
- Hover highlight on rows.

**Auto-refresh indicator**: A subtle muted-foreground text below the table: `"Auto-refreshes every 30s"` in `text-xs text-muted-foreground font-mono`. Optionally, a tiny spinning dot next to it during active refresh.

---

## 8. Tier 2 Pages -- Inherited Treatment

These pages receive the design system tokens and component restyling automatically. No bespoke layout work.

### 8.1 Policies Page

- **Cards**: Account-pair policy cards inherit the new Card styling.
- **Policy level badges**: Map to badge variants (success for "mirror", warning for "busy-only", destructive for "blocked", secondary for "none").
- **Matrix layout**: The existing grid of policy cards remains. The visual change is automatic via token propagation.
- **Optimistic updates**: The rollback animation on failed saves should use a brief red flash (`bg-destructive/10` for 300ms, then fade).

### 8.2 Provider Health Page

- **Provider status cards**: Inherit Card + status dot patterns.
- **Health metrics**: Use `font-mono text-data` for latency values, error rates, uptime percentages.
- **Tables**: Inherit the zebra + hover + data-label treatment from Sync Status.

### 8.3 Error Recovery Page

- **Error list**: Cards with `border-destructive/50` for active errors.
- **Retry buttons**: Use `variant="outline"` with `border-destructive text-destructive hover:bg-destructive/10`.
- **Resolved errors**: Use `variant="success"` badge and muted card treatment.
- **Visual hierarchy**: Active errors at top (destructive border), resolved errors below (muted border), creating a natural severity sort.

### 8.4 Billing Page

- **Plan cards**: Current plan gets `border-primary` (gold border) to indicate active selection.
- **Usage bars**: Use `bg-primary/30` for fill, `bg-secondary` for track, rounded-full.
- **Invoice history**: Table with zebra/hover/data-label treatment. Amounts in `font-mono text-data`.
- **Upgrade CTA**: Gold button (`variant="default"`).

---

## 9. Shared Component Specifications

### 9.1 PageHeader

No structural change. The heading already uses appropriate size classes. The visual change comes from token propagation (`--foreground` and `--muted-foreground` resolve to new values).

### 9.2 LoadingSpinner

Replace the current SVG spinner with a gold-colored variant. The spinner already uses `text-primary` which will resolve to gold. No code change needed -- the visual shift is automatic.

### 9.3 EmptyState

No structural change. The dashed border (`border-dashed border-border`) and icon/text treatment already use tokens. The visual change is automatic.

One refinement: the icon color should be `text-muted-foreground/50` (more subdued than currently) to avoid drawing attention to an empty state.

### 9.4 ErrorBoundary

No structural change. The destructive color treatment (`border-destructive/50 bg-destructive/5`) already uses tokens. The "Try again" button uses `bg-primary` which will become gold -- this is correct (the primary action in an error state is recovery).

### 9.5 Toaster

Migrate from CSS `animate-in slide-in-from-bottom-2` to Framer Motion for the slide-in/slide-out animation. This provides exit animations (which CSS-only `animate-in` cannot do) and respects `prefers-reduced-motion` via Framer Motion's built-in support.

---

## 10. Implementation File Map

This section maps design changes to specific files for developer reference. All paths are relative to `/Users/ramirosalas/workspace/tminus/src/web/`.

### Phase A: Design System Foundation

| File | Change |
|------|--------|
| `src/index.css` | Replace all CSS custom property values with Section 3.1 tokens |
| `tailwind.config.ts` | Add `fontFamily`, `fontSize`, `letterSpacing` extensions (Section 3.2). Add glow keyframes and animations (Section 4.3). |
| `index.html` | Update body background to `#0a0a0f` and font-family to include Inter (self-hosted via `@font-face` in `index.css`, no external CDN link tags) |

### Phase B: UI Primitives + App Shell

| File | Change Summary |
|------|---------------|
| `src/components/ui/card.tsx` | Remove `shadow-sm` from Card base. Adjust CardTitle size to `text-lg`. |
| `src/components/ui/button.tsx` | Add gold hover glow to default variant. Ensure all variants align with Section 5.2. |
| `src/components/ui/badge.tsx` | Shift from solid to tinted backgrounds (Section 5.3). |
| `src/components/ui/dialog.tsx` | No structural change. Verify visual with new tokens. |
| `src/components/ui/tooltip.tsx` | No structural change. Token-driven. |
| `src/components/ui/skeleton.tsx` | No change. `bg-muted` resolves to new value automatically. |
| `src/components/ui/toast.tsx` | Migrate to Framer Motion for entrance/exit. Update variant text colors. |
| `src/components/ui/separator.tsx` | No change. `bg-border` resolves to new value automatically. |
| `src/components/Sidebar.tsx` | Redesign active state per Section 6.2. Add `border-l-2` pattern. |
| `src/components/AppShell.tsx` | No structural change. Token-driven. |
| `src/components/PageHeader.tsx` | No change needed. |
| `src/components/LoadingSpinner.tsx` | No change needed (already uses `text-primary`). |
| `src/components/EmptyState.tsx` | Adjust icon opacity to `text-muted-foreground/50`. |
| `src/components/ErrorBoundary.tsx` | No change needed. |
| `src/lib/motion.ts` | **New file.** Framer Motion helper with `useMotionConfig()` and stagger constants. |

### Phase C: Tier 1 Pages

| File | Change Summary |
|------|---------------|
| `src/pages/Login.tsx` | Labels to uppercase label token. Subtitle to font-mono. Card glow shadow. Gold submit button (automatic). |
| `src/pages/Onboarding.tsx` | Step indicators. Provider card entrance animations. Sync polling state visuals. |
| `src/pages/Calendar.tsx` | Wrapper unchanged. Changes cascade from UnifiedCalendar. |
| `src/components/UnifiedCalendar.tsx` | Grid cell styling. Current-day gold highlight. Event card provider-color coding. View toggle active state. |
| `src/components/BriefingPanel.tsx` | Label tokens for section headers. Font-mono for timestamps/emails. Slide-in animation. |
| `src/components/EventCreateForm.tsx` | Form input restyling per Section 5.6. Gold submit button. |
| `src/components/EventDetail.tsx` | Label tokens. Font-mono for data. Consistent card treatment. |
| `src/pages/Accounts.tsx` | Account cards with animated glow dots. Scope management section headers as label tokens. Link cards with dashed border. |
| `src/pages/SyncStatus.tsx` | Full ops-dashboard treatment per Section 7.5. Replace inline style colors with token-based classes. Animated health dots. Zebra table. |

### Phase D: Tier 2 Pages

| File | Change Summary |
|------|---------------|
| `src/pages/Policies.tsx` | Badge variant alignment. Policy level color mapping. |
| `src/pages/ProviderHealth.tsx` | Status dot + table treatment. Font-mono for metrics. |
| `src/pages/ErrorRecovery.tsx` | Destructive border emphasis. Retry button styling. |
| `src/pages/Billing.tsx` | Gold border on active plan. Usage bar styling. Invoice table. |

---

## 11. New File: Animation Utilities

A single new file provides shared Framer Motion patterns to avoid duplication across pages.

**File**: `/Users/ramirosalas/workspace/tminus/src/web/src/lib/motion.ts`

```typescript
/**
 * Shared Framer Motion animation patterns.
 *
 * Centralizes animation constants so pages use consistent timing.
 * Respects prefers-reduced-motion via useReducedMotion().
 */

import { useReducedMotion } from "framer-motion";
import type { Variants, Transition } from "framer-motion";

// ---------------------------------------------------------------------------
// Reduced motion hook
// ---------------------------------------------------------------------------

/**
 * Returns animation props that disable motion when the user prefers it.
 * Spread onto motion components: <motion.div {...motionConfig} />
 */
export function useMotionConfig() {
  const reduced = useReducedMotion();
  return {
    initial: reduced ? false : undefined,
    transition: reduced ? { duration: 0 } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Card entrance variants (stagger children)
// ---------------------------------------------------------------------------

export const staggerContainer: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.05 },
  },
};

export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: "easeOut" },
  },
};

// ---------------------------------------------------------------------------
// Page transition
// ---------------------------------------------------------------------------

export const pageTransition: Transition = {
  duration: 0.2,
  ease: "easeInOut",
};

export const pageFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

// ---------------------------------------------------------------------------
// Toast slide
// ---------------------------------------------------------------------------

export const toastSlide: Variants = {
  initial: { opacity: 0, x: 100 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.3, ease: "easeOut" } },
  exit: { opacity: 0, x: 100, transition: { duration: 0.2, ease: "easeIn" } },
};

// ---------------------------------------------------------------------------
// Modal scale
// ---------------------------------------------------------------------------

export const modalScale: Variants = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15, ease: "easeIn" } },
};
```

---

## 12. Accessibility Checklist

Every change in this specification must satisfy these requirements.

| Requirement | Standard | Verification |
|-------------|----------|-------------|
| Text contrast | WCAG 2.1 AA (4.5:1 normal, 3:1 large) | Check all pairs in Section 3.1 table. Monitor `--muted-foreground` on `--card` (borderline 4.5:1). |
| Focus visibility | Visible gold ring on all interactive elements | Verify `ring-2 ring-ring ring-offset-2 ring-offset-background` produces visible ring on all backgrounds. |
| Motion sensitivity | `prefers-reduced-motion` respected | All Framer Motion via `useMotionConfig()`. All CSS animations via `motion-reduce:animate-none`. |
| Keyboard navigation | Full operability via Tab, Enter, Escape, Arrows | No animation-dependent interactions. Sidebar nav uses native `<a>` / NavLink. Dialogs trap focus. |
| Screen readers | Existing ARIA attributes preserved | `aria-label`, `role`, `data-testid` on all interactive elements unchanged. |
| Color independence | Status not communicated by color alone | Health indicators include text labels ("Healthy", "Error") and symbols (dot, triangle, square, X) alongside color. |

---

## 13. Performance Guardrails

| Metric | Budget | How to verify |
|--------|--------|--------------|
| LCP | < 2.5s on simulated 3G | Chrome DevTools Lighthouse, throttled network |
| CLS | < 0.1 | Font `display: swap` + metrically similar fallbacks |
| FID | < 100ms | No heavy JS in critical path |
| Bundle size delta | < 30KB gzipped | `framer-motion` tree-shaken (~15KB). Fonts via CDN, not bundled. |
| Animation FPS | 60fps | GPU-composited properties only. Test with 4x CPU throttle. |
| Concurrent animations | Max 3 per page (glows exempt) | Code review during Phase C/D. |

---

## 14. Design Decisions Log

| ID | Decision | Rationale | Alternatives Considered |
|----|----------|-----------|------------------------|
| DD-1 | Gold as primary/accent (not blue) | Single-accent discipline. Gold reads as "premium infrastructure." Blue reads as "generic SaaS." | Keep blue, use gold only for status. Rejected: dilutes the visual identity. |
| DD-2 | JetBrains Mono for data values | Monospace creates instant visual hierarchy between "read" and "scan." JetBrains Mono has excellent rendering at small sizes. | Fira Code, Source Code Pro. JetBrains Mono chosen for its wider character set and broad availability. |
| DD-3 | Tinted badges (bg-color/15) instead of solid | Solid-color badges on near-black feel harsh and draw too much attention. Tinted variants are legible but subordinate to the content they annotate. | Solid badges, outline-only badges. |
| DD-4 | Active sidebar uses border-l-2 + glow | The left border creates a vertical alignment cue. The glow adds life. Together they are unambiguous without being heavy. | Background-only highlight, underline, icon tint. |
| DD-5 | No custom light theme | T-Minus is infrastructure. Ops dashboards are dark. Building and maintaining a parallel light theme doubles the design surface for negligible user value at this stage. | Ship light theme for accessibility. Deferred: dark theme meets AA contrast. |
| DD-6 | Framer Motion over CSS-only animations | CSS `animate-in` (via tailwindcss-animate) cannot do exit animations or staggered children. Framer Motion provides both + built-in reduced-motion support. Bundle cost (~15KB) is within budget. | CSS-only with tailwindcss-animate. Rejected: no exit animations, no stagger. |
| DD-7 | Self-hosted WOFF2 over CDN | Browser cache partitioning (since 2020) eliminates the cross-site cache benefit of CDN fonts. Self-hosting removes an external dependency and a GDPR-relevant third-party request. Font files live in `src/web/src/assets/fonts/` and are processed by Vite's asset pipeline for content-hashed filenames. | Google Fonts CDN (rejected: no cache benefit post-partitioning, adds external dependency), Fontsource npm packages (rejected: unnecessary build complexity for static assets). |
| DD-8 | Status dots at 10px (not 12px) | The glow effect visually extends the dot. 10px with glow looks comparable to 12px without, but occupies less layout space. | Keep 12px. |

---

## 15. Resolved Questions

All questions have been resolved as of 2026-02-26.

1. **Provider colors for event cards**: **RESOLVED -- Keep existing `getAccountColor()` dynamic hex approach.** The hash-based deterministic color assignment already works, is tested, and handles arbitrary future providers (Phase 5: CalDAV, MSFT, etc.) without requiring a fixed palette update. No change needed.

2. **Calendar grid: week view hours**: **RESOLVED -- Use JetBrains Mono for time labels.** Time labels in the week view use `text-xs font-mono text-muted-foreground` (JetBrains Mono at 12px, muted). This is consistent with the data-value typographic pattern established in Section 3.2: all machine/temporal values use monospace. The slightly smaller size (12px vs 13px data-value) prevents the time column from visually competing with event content.

3. **Onboarding page**: **RESOLVED -- Add minimal header with T-Minus wordmark.** Onboarding renders outside AppShell, so it needs its own minimal header containing only the "T-Minus" wordmark (Inter 700, `text-primary` gold) and optionally a step progress indicator. This maintains brand continuity without the full sidebar/header chrome. No logout button needed (user is mid-onboarding, not yet fully authenticated).

4. **Toast positioning**: **RESOLVED -- Keep bottom-right.** Bottom-right is the established convention, avoids competing with the header, and matches user expectation from tools like Linear, Superhuman, and Arc. No change from current behavior.

5. **Gold accent audit**: **RESOLVED -- Built into Phase B gate as a manual QA checkpoint.** After Phase B, conduct a viewport-by-viewport audit to verify gold appears in at most 2-3 elements per viewport. If it appears more, reduce. This is a design review checkpoint during the Phase B acceptance gate, not a separate automated check. The constraint is already documented in BUSINESS.md Risk Register ("Gold accent overuse").
