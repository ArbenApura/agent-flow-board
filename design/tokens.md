# Design tokens (Graphite)

Chosen direction is Graphite (ADR-033). Components read these tokens only. No component carries a literal colour.

## Colour, light and dark

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f3f4f7` | `#0c0e11` | Page background |
| `--surface` | `#ffffff` | `#171b21` | Cards, headers, inputs on raised areas |
| `--raised` | `#eceff3` | `#212730` | Chips, progress track, callouts |
| `--ink` | `#14171c` | `#f1f3f6` | Text |
| `--muted` | `#565d68` | `#a7aebb` | Secondary text |
| `--line` | `#d5d9e0` | `#333a45` | Hairlines and borders |
| `--accent` | `#2563eb` | `#6b9bff` | Primary action, focus, selected |
| `--accent-ink` | `#ffffff` | `#071634` | Text on the accent |
| `--accent-soft` | `#dde8fd` | `#1a2a4d` | Selected tint, running badge |
| `--accent-text` | `#1d4ed8` | `#6b9bff` | Accent text on the soft tint |

Fixed semantic colours, the same for every org palette.

| Token | Light | Dark |
|---|---|---|
| `--danger` | `#c62828` | `#ff7b72` |
| `--warning` | `#a15c00` | `#f0b429` |
| `--success` | `#1b7a3d` | `#4ade80` |
| `--info` | `#1565c0` | `#79b8ff` |

## Contrast results (WCAG ratio)

| Pair | Light | Dark | Needs |
|---|---|---|---|
| ink on bg | 16.28 | 16.39 | 4.5 |
| ink on surface | 17.76 | 15.32 | 4.5 |
| muted on bg | 5.72 | 7.31 | 4.5 |
| muted on surface | 6.24 | 6.83 | 4.5 |
| accent-ink on accent | 5.17 | 6.61 | 4.5 |
| accent on surface | 5.17 | 6.58 | 3 (non-text) |
| accent-text on accent-soft | 5.44 | 5.23 | 4.5 |
| danger on surface | 5.62 | 7.06 | 4.5 |
| warning on surface | 5.19 | 9.55 | 4.5 |
| success on surface | 5.39 | 10.22 | 4.5 |
| info on surface | 5.75 | 8.58 | 4.5 |

The plain accent on the soft tint is 4.19 in light mode, so text on the soft tint uses `--accent-text`. Phase 2 enforces this in the palette generator for any org colour.

## Type

Geist Sans for text, Geist Mono for IDs, hashes and code, both variable files, self-hosted. Tabular figures on every number in a table.

## Scale per level

UI shots measure against these values. Sizes are CSS pixels. Desktop is 1440 wide and phone is 390 wide. A value off this table, or larger than its sibling at the same level, is a "to fix" flag.

| Level | Desktop | Phone | Notes |
|---|---|---|---|
| `title` | 28 / 600 / line 36 | 22 / 600 / line 30 | One per page, in the page header |
| `section` | 18 / 600 / line 28 | 18 / 600 / line 28 | Card, panel and tab headings |
| `body` | 15 / 400 / line 24 | 15 / 400 / line 24 | Default text. Nothing a person must read is smaller than 13 |
| `label` | 13 / 500 / line 18 | 13 / 500 / line 18 | Field labels, table heads, helper text, the metadata under a title |
| `badge` | 12 / 600 | 12 / 600 | Status badges and counts only (`data-badge`, `data-count`), the one exemption from the 13 minimum |
| `button-primary` | height 40, 15 / 500, radius 8 | height 44 | One per view |
| `button` | height 40 (32 compact in tables), 15 / 500, radius 8 | height 44 | Secondary actions |
| `button-icon` | 40 x 40 hit area, 20 icon | 44 x 44, 20 icon | Icon only, always with an aria-label |
| `input` | height 40, 15 / 400, radius 8, padding 12 | height 44 | Text fields and selects |
| `card` | radius 12, padding 16, 1px `--line` | padding 14 | No shadow |
| `row` | table row padding 10, list row height 48 | height 56 | Lists and tables |
| `icon` | 16 inline, 20 in buttons, 24 in empty states | same | Phosphor, regular weight |
| `image` | thumbnails 120 x 80, radius 8 | 96 x 64 | Attachments and shots |

## Spacing and shape

Spacing steps are 4, 8, 12, 16, 24, 32. Radius is 6 (chips and small controls), 8 (buttons and inputs), 12 (cards and screens), 999 (badges and switches). Touch targets are at least 44 px on a phone and 40 px on a desktop. Focus ring is 2 px `--accent` with 1 px offset.

## Container (ADR-003)

One frame holds the navigation and every page: max width 1280 px including the gutters, gutters 32 px on a desktop and 16 px on a phone, centred. It is `PageFrame` (`data-testid="page-frame"`; the navigation uses the same component as `nav-frame`). No page has its own width. A screen that reads best narrow keeps the frame and uses columns inside it. The page header (`PageHeader`) is the same on every page: title, one line of context, actions on the right. `tests/checks/frame.spec.ts` checks the left edge and width on every screen.

## Disclosure (ADR-004)

A page does one job. Secondary actions live in a popover, creation in a modal or a drawer, detail in the side drawer, and long pages are split into tabs. Settings show one section at a time in a side tab column (`SettingsShell`, the tab is `?tab=<section id>`). Board filters are a Filters popover whose state is in the URL.

## Overlay contract (ADR-010)

- A dialog is a centred modal on a wide screen and a bottom sheet on a phone. A drawer (`ResponsiveModal variant="drawer"`) is a right hand panel from 640 px up and a bottom sheet below it, switched in CSS only, so there is no layout flash.
- Escape closes only the topmost layer. The background does not scroll while one is open. Focus moves in on open and returns to the opener on close. A modal or drawer traps Tab.
- Every icon only control has an `aria-label`. Touch targets are at least 44 px on a phone.
- Anything a person can link to has a URL (a tab, a filter, a view). Back closes a drawer that has a URL.

## Visuals (ADR-005)

Progress, order, time and people are drawn. `ProgressRing` shows an item's percent with a fixed status colour (info while in flight, success when done) and never the org accent. `Avatar` shows a person or a logo tile with initials as the fallback. `Illustration` is the one illustration style (rounded shapes in the surface, line and accent tokens), used only on empty, error and welcome screens and beside the sign in form.
