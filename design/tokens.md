# Design tokens (Graphite)

Chosen direction is Graphite (ADR-033). Components read these tokens only. No component carries a literal colour.

## Colour, light and dark

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f4f5f7` | `#0e1013` | Page background |
| `--surface` | `#ffffff` | `#15181c` | Cards, headers, inputs on raised areas |
| `--raised` | `#ebedf0` | `#1d2127` | Chips, progress track, callouts |
| `--ink` | `#16181d` | `#eceef1` | Text |
| `--muted` | `#5b616b` | `#9aa1ab` | Secondary text |
| `--line` | `#dcdfe4` | `#2a2f37` | Hairlines and borders |
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
| `title` | 24 / 600 / line 32 | 20 / 600 / line 28 | One per page |
| `section` | 18 / 600 / line 26 | 16 / 600 / line 24 | Card and panel headings |
| `body` | 14 / 400 / line 22 | 14 / 400 / line 22 | Default text |
| `label` | 12 / 500 / line 16 | 12 / 500 / line 16 | Field labels, table heads, badges (table heads uppercase, 600) |
| `button-primary` | height 44, 14 / 500, radius 8 | height 44 | One per view |
| `button` | height 44 (32 compact in tables), 14 / 500, radius 8 | height 44 | Secondary actions |
| `button-icon` | 44 x 44 hit area, 20 icon | 44 x 44, 20 icon | Icon only |
| `input` | height 44, 14 / 400, radius 8, padding 12 | height 44 | Text fields and selects |
| `card` | radius 12, padding 16, 1px `--line` | padding 14 | No shadow |
| `row` | table row padding 10, list row height 48 | height 56 | Lists and tables |
| `icon` | 16 inline, 20 in buttons, 24 in empty states | same | Phosphor, regular weight |
| `image` | thumbnails 120 x 80, radius 8 | 96 x 64 | Attachments and shots |

## Spacing and shape

Spacing steps are 4, 8, 12, 16, 24, 32. Radius is 6 (chips and small controls), 8 (buttons and inputs), 12 (cards and screens), 999 (badges and switches). Touch targets are at least 44 px. Focus ring is 2 px `--accent` with 1 px offset.
