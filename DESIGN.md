# shujian / Register Dashboard — Design System

This file is the canonical source for visual decisions in `apps/dashboard`.
Anything that contradicts it is wrong; fix the code, not the doc.

## Scene sentence

A platform engineer at 23:30, single 27" monitor in a dim home office, glass
of water cooling next to the keyboard, deciding whether to ship the Cursor
agent that just opened a PR. They flick between agent runs the way Linear
users flick between issues — keyboard-first, no patience for chrome.

That sentence forces a **dark-default** UI tinted warm (not blue). Light
theme exists for daylight use but is never the canonical screenshot.

## Color strategy: Restrained

Tinted neutrals (warm, hue ≈ 60° / amber bias, very low chroma) plus exactly
one accent — a warm orange used ≤8% of any surface. Status colors (green /
amber / red) are functional, never decorative.

OKLCH everywhere. No `#000` or `#fff`. Every neutral has chroma ≥ 0.005.

### Tokens (canonical names — see `src/index.css`)

```
--bg          oklch(0.158 0.006 70)        page
--surface     oklch(0.196 0.007 70)        panels, sidebar
--surface-2   oklch(0.232 0.008 70)        elevated rows, popovers
--surface-3   oklch(0.275 0.009 70)        hover row, active chip
--line        oklch(0.292 0.011 72)        hairline 1px
--line-strong oklch(0.358 0.013 72)        emphasized borders
--ink         oklch(0.962 0.008 80)        primary text
--ink-muted   oklch(0.745 0.012 75)        secondary text
--ink-dim     oklch(0.555 0.014 72)        tertiary, hints
--ink-inv     oklch(0.158 0.006 70)        text on accent

--accent      oklch(0.745 0.155 55)        warm orange — calls to action
--accent-hi   oklch(0.812 0.146 60)        hover
--accent-lo   oklch(0.395 0.108 50)        pressed / used as glyph color on tinted bg
--accent-tint oklch(0.745 0.155 55 / 0.12) bg tint, hover halo

--ok          oklch(0.745 0.142 158)       running/healthy
--warn        oklch(0.802 0.158 88)        attention
--bad         oklch(0.685 0.218 25)        error/failed
--info        oklch(0.685 0.118 240)       informational only

--ring        oklch(0.745 0.155 55 / 0.45) focus halo
```

Light theme flips the L axis (bg ≈ 0.98) and lowers accent chroma to 0.12;
hue stays. Never invert the accent — orange is the brand, not a "primary
color slot."

### Use rules

- Accent is for **the** primary action only. One per surface. Used in:
  CTAs, the active nav state's leading dot, brand mark, single hovered link
  in a list. Never for icons in a row, never for chart fills outside the
  primary series.
- Status colors are **functional**: green = running, amber = needs input,
  red = failed. Never paint a row in a status color; use the dot + a tinted
  background only on detail surfaces.
- Gray text on a gray background must use the same hue family. No pure
  desaturated grays.

## Typography

Stack — Geist Sans for UI, Geist Mono for code/IDs/timestamps, system font
fallback. The dashboard self-hosts both via `fonts.bunny.net` style CSS or
`@fontsource/geist-*`. Chinese falls back to `PingFang SC, Hiragino Sans GB,
Microsoft YaHei`.

```
xs    11px / 16px      labels, table heads, status pills
sm    13px / 19px      body in dense rows, sidebar nav
base  14px / 22px      forms, dialog body, page sub
md    16px / 24px      page content body
lg    18px / 26px      section headings
xl    22px / 30px      page title (e.g. "Agents")
2xl   28px / 36px      login headline only
```

Tracking: -0.01em on lg+, 0 on base, +0.005em on sm-and-below for clarity.
Numerals use `font-feature-settings: 'tnum' 1, 'cv11' 1` so timestamps and
durations align in tables.

Hierarchy is built with **scale + weight** (regular 400, medium 500, semibold
600). No light weights, no extrabold; nothing says "AI made this" louder than
weight 200.

## Layout grid

12-column on a 4px baseline. Standard side padding = 24px (1.5rem). Sidebar
fixed at 240px. Topbar fixed at 48px. Right detail rail = 360px when open.

Container widths:
- Login: 480px form column on the right of an asymmetric 60/40 split.
- Settings forms: 720px max — a single readable column.
- Agents list: full width minus rail; rows use 12-col with `[grid-template-columns: 24px 1.6fr 0.6fr 1fr 1fr 64px 32px]`.

Spacing scale (Tailwind defaults are fine): 1, 2, 3, 4, 6, 8, 12, 16, 24.
The "13px gap" or "every padding is 16" reflex is banned.

## Components

- **Panel** — 1px line border, `--surface`, no shadow. Shadows imply paper;
  this UI is a console. Elevation is conveyed by hue offset only.
- **Button (primary)** — solid `--accent`, `--ink-inv` text, no shadow, 1px
  inset highlight on top via `box-shadow: inset 0 1px 0 rgba(255,255,255,0.12)`.
- **Button (secondary)** — `--surface-2` bg, 1px `--line-strong` border.
- **Button (ghost)** — transparent, hover → `--surface-2`.
- **Pill** — 22px tall, 11px text, 1px border using its color family at low
  chroma; bg is the same color at 0.12 alpha. Status pills carry no border
  shift on hover (they're informational, not interactive).
- **Input / textarea** — `--surface` bg, `--line` border, focus → 2px ring
  using `--ring`. Border on focus shifts to `--accent` at chroma 0.10.
- **Row** — 44px tall, hover bg = `--surface-3`, selected bg = same +
  4px-wide leading bar of `--accent` ON THE INSIDE EDGE only? **NO**. Use
  full bg tint + leading dot. Side stripes are banned.
- **Sparkline** — pure SVG, 1px stroke `--ink-muted` for inactive series,
  `--accent` for the focused one. Never gradients.

## Motion

Easing — only these:
```
--ease-out: cubic-bezier(0.22, 1, 0.36, 1)   /* default */
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1) /* page transitions */
```

Durations:
- 90ms hover (color/opacity)
- 150ms feedback (button press, chip toggle)
- 220ms state (drawer, popover)
- 320ms layout (rail open, view transition)

Animate `transform` and `opacity` only. Status dots use a 1.6s `pulse`
animation when running. Reduced-motion: `transition-duration: 0` on every
non-feedback transition; status dot becomes static.

### Signature motion (overdrive)

Two committed moments:

1. **Login system pulse.** The left 60% panel of `/login` runs a CSS-only
   sparkline that scrolls horizontally on a `requestAnimationFrame` loop,
   plus an event ticker fed by mock data — together they read as "the
   platform is alive." On `prefers-reduced-motion` they freeze on the
   latest frame instead of stopping mid-animation.
2. **Agents list ↔ detail rail.** Selecting a row uses the View Transitions
   API to morph the row's title text and status dot into the rail header.
   Falls back to a 220ms fade-slide on Firefox.

These are the only large motion moments. Everything else stays at 90–150ms.

## Iconography

Lucide, 1.6 stroke, 16px in dense rows, 18px in topbar, 14px in pills.
No filled / dual-tone icons. Icons in nav are `--ink-dim` resting,
`--ink` on hover, `--accent` on the active route.

## States — the non-negotiables

Every interactive element has: default, hover, focus-visible, active,
disabled, loading. Every async surface has: empty, error, loading skeleton.
Forms have: idle, validating, success, recoverable error, server error.

Focus rings are 2px `--ring`, offset 1px from the element. Never remove the
ring without replacement.

## Banned patterns (audited at PR time)

- Side-stripe borders, gradient text, glassmorphism, hero metric template,
  identical card grids, modal-as-first-thought.
- Rounded corners > 12px on functional surfaces (the platform is a console,
  not a phone app). 6px on inputs, 8px on panels, 10px on dialogs.
- "Beautiful empty state illustration" with vector blobs. Empty states are
  a single line + single CTA + small monospace hint. That's it.
- Any animation that delays user input.

## Accessibility floor

- Body text ≥ AA on every surface. `--ink` on `--bg` is 14:1, `--ink-muted`
  on `--bg` is 5.4:1, `--ink-dim` is 3.4:1 (only used for non-essential).
- Tab order matches reading order on every page.
- All status carries text + dot, never color alone.
- Focus visible on every keyboard tab — verified by the audit pass.
