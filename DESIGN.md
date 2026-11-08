# Design

How Agent Flow Board looks and moves, and what was tried and dropped. Read this before changing any screen. Colour tokens, the size scale and the layout rules are in the second half of this file. The machine form of the scale is `tests/ui-shots/scale.json`.

## Principles

- **Crisp, not flashy.** Solid surfaces, clear 1px borders, tight shadows. Add character in small steps, starting restrained.
- **Even and symmetrical.** Columns share widths, and things that sit together share one left edge.
- **Alive, not busy.** Motion explains something (progress, flow) and never loops without a reason.
- **Light and dark are equal.** Check every change in both. Components read tokens only, never a literal colour.

## Name

The product is **Agent Flow Board** in everything people read: wordmarks, emails, API docs, page titles. Technical ids keep `agent-flow-board` (package `@agent-flow-board/bridge`, the MCP server name, the snapshot format, the user-agent, `claude mcp add agent-flow-board`). Renaming those breaks existing setups.

## Type

- **Poppins** for text, 400 to 700.
- **Bricolage Grotesque** for headings (h1 to h4) and all bold or semibold text, at a large optical size for its character. One rule in `src/app.css` applies it to headings, `.font-semibold`, `.font-bold`, `b` and `strong`.
- **Geist Mono** for ids, hashes and code.
- Fonts are self-hosted in `static/fonts`, declared in `src/app.css`. Never load from Google.

## Logo

`src/lib/ui/Logo.svelte` is the mark plus the name. Use it, never hand-build a wordmark.

- Keep the original mark (`Mark.svelte`), with no tile behind it.
- "Agent" and "Board" are semibold in the text colour. "Flow" is bold with an accent gradient and a thin wave underneath.
- Keep the wave's box taller than the curve so it never clips, and let the svg overflow for the breathing animation.
- Dropped: a tile behind the mark, a glow on "Flow", an end dot on the wave, extra-bold weights.

## Sign-in pages

`src/lib/ui/AuthShell.svelte` frames sign in, sign up, verify, forgot and reset.

- Two equal halves on wide screens. The left half is one centred column with the same width as the form card: logo at the top, the product card and headline in the middle, a quiet line at the bottom, all on one left edge.
- The form card is centred in the right half. Below it, one line for the other page.
- Below 1024px only the form shows, with the logo above it.
- The loading placeholder (`#afb-boot` in `src/app.html`) mirrors this layout, so nothing jumps when the app mounts.
- Password fields carry a placeholder. Google is the only social login, shown only when its keys are set, under an "or" divider.

## Cards

`src/lib/ui/AuthCard.svelte` is the card for the sign-in pages.

- Solid surface, a clear 1px `--line` border, a hairline of light on top, one contact shadow and one soft drop shadow.
- The sign-in card has a solid 2px accent line along its top edge. The plan card does not.
- The badge at the top of a form card is an outlined accent tile (accent at about 12% fill, about 35% border, accent text). A solid accent tile is too harsh, and a pale tint disappears on dark.
- Dropped: frosted glass and blur, gradient borders, a glow patch behind the card, a cursor spotlight on the card.

## Motion

Everything decorative is off under `prefers-reduced-motion`, which shows the still final state. Keyframes live at the end of `src/app.css`.

- **Plan card** on the sign-in panel plays a 12 second loop: steps tick off and get struck through one by one, the ring fills and counts up, the agent message moves from step 1 to 3 then to done, then it resets.
- **Logo** draws itself on load (nodes pop, lines and check draw), then the wave under "Flow" breathes and the gradient drifts.
- **Panel content** fades up in sequence, and the background glow drifts slowly.
- Use CSS for decoration. Reach for a canvas only for the background.

## App shell

Every page after sign in sits in one shell, a sidebar on the left and a top bar over the page.

- **Two layouts, one frame.** Pages of an organisation (`src/routes/[org]/`) use `AppSidebar` and the organisation top bar. Pages that belong to no organisation (`src/routes/(account)/`: the organisations list, Connect a tool, Your settings) use `AccountSidebar` and a lighter top bar. Both sidebars are built from `SidebarShell`, `SidebarRow`, `SidebarHeading` and `OrgTile` in `src/lib/board/`. A new sidebar page belongs in one of the two layouts, never with a header of its own.
- **The sidebar is a 64px rail.** It shows icons only, opens to 256px over the page when the pointer or focus is on it, and stays open while its account menu is showing. It opens over the content, so the page never reflows. There is no collapse button and no saved choice. Only the width and a fade of the labels animate, icons never move.
- **Project pages.** A project's pages sit under it in the sidebar and in the phone menu, in this order: Registry, Tasks, Activity, Health, Mockups, then Trash and Project settings. Mockups uses the `PanelsTopLeft` icon and is also in the command palette, which reads the same list.
- **Connect a tool has three sections.** The tools and tokens, the Skills tab (`?tab=skills`) and the Editor status tab (`?tab=editor`), as a plain link bar under the header with the sizes of the tab row inside its tools card; the bar scrolls sideways on a phone like any tab row. Create token stays the page's only primary button; Copy install prompt, Download bundle and Copy setup prompt are plain buttons. The Editor status tab has a live line (a dot, who the bridge is signed in as, a badge) in one of five states: signed in, not set up, expired, needs Manage, and not read.
- **Class names are written in full.** Tailwind builds only the classes it can read in the source, so a class made from a variable (`${prefix}:hidden`) is never generated. The rail state is the `side-collapsed:` variant, defined in `src/app.css`.
- **The top bar** holds the breadcrumb, search (organisation pages), the light and dark switch (`ThemeToggle`, on both layouts, phones included) and the account menu. Search is not in the sidebar.
- **Colour belongs to the organisation.** A person picks light or dark and nothing else. There is no personal accent. The accent, logo and palette are set once in Organisation settings under "Organisation colour and logo", and the account screen says so. The light and dark choice applies and saves as it is picked, with no Save button.
- **An organisation is shown as `OrgTile`**: its logo, or two capital letters on one of four theme tints chosen from its address, the same everywhere.
- **A project is shown as `ProjectTile`**: its logo, or the first two letters of its key in mono on the raised surface, at 24 or 40 and nothing between. A person is shown as `Avatar`: their picture, or initials. Both pictures are set in settings (`PictureUpload`, a PNG, JPEG or WebP under 200 KB) and read from `/pictures`, never inlined in page data.
- **The loading placeholder draws this shell** (`#afb-boot` in `src/app.html`): the rail, the top bar and the shape the page had last time. A new page shape adds its own block there and sets `data-org` in the boot script.
- **Database round trips are a design input.** The database can be far from the person developing, so a page that makes many queries in a row is slow. Run independent loads in parallel and avoid a transaction for a check that rarely changes.

## Mockups

A design mockup is one interactive HTML page a coding tool draws for a plan or a screen, saved on the board and never in the repo. It is inspiration, never the spec. No new colour token, size or font: every screen below is built from the existing scale and components.

- **The Mockups page** (`/[org]/[project]/mockups`) copies the Tasks page: `PageHeader` with no actions (tools make mockups, and there are no mockup settings: an old `/mockups/settings` address redirects here), one toolbar card (search, a Filters popover, a Cards and List switch kept in the address), and cards like `TaskCard`. A card has its preview across the top, a 16 to 10 area (radius 8, on every width, the `card-preview` level in `scale.json`), then the title, the plan reference in mono, the version, the age and a Public or Private badge. The preview is larger than the 120 by 80 image level because a design cannot be judged at 120 px. It shows the screenshot, or a live preview of the page when there is none (a sandboxed frame that runs no script, drawn at 1280 by 800 and scaled in, loaded only near the screen), over the quiet placeholder icon that a failed preview leaves showing. The list view has no preview.
- **The viewer** (`/[org]/[project]/mockups/[id]`) is a header band, a Reference notice (inspiration, never the spec) and a Preview card. The Preview card header puts the version badge on the same line as the title, with the sandbox line under it. The preview is a device: `DeviceFrame` draws a browser window for Wide and Laptop (a 40 px bar with three 10 px dots and a pill with the mockup title, no real address) and a tablet or a phone for the other two, around one sandboxed frame. The screen is the device's real viewport (Wide 1600 by 900, Laptop 1280 by 800, Tablet 820 by 1100, Phone 408 by 840) and the whole device is shrunk to the stage width, never enlarged, so nothing is cut off and the stage has no fixed height. The mockup scrolls inside its screen, never the page. Chromium scales with CSS `zoom`, which lays the page out at the smaller size and keeps text sharp; other browsers use a transform. The device switch is the `SegmentedControl` with an icon and a label per device. Changing device animates the frame to its new size over 0.3 s, with the mockup re-flowing live as it does (Chromium; the other browsers glide the box only; `motion-reduce` removes it). History and Share are drawers, Link to a plan a dialog, and Move to the trash asks first.
- **Device frame sizes and colours.** Tablet bezel 14 px, radius 24. Phone bezel 12 px, radius 36 and a 4 px home bar. There is no camera, notch or speaker on any frame: it would cover the top of the mockup. These are fixed by what makes a frame read as that device and are not controls, so they are the only new pixel values besides the card preview. Colours are tokens only, mixed per mode: the bezel is `--ink` 80% into `--surface` in light mode and `--ink` 18% into `--surface` in dark mode, with a 1 px `--line` edge, on a `--raised` stage, so it reads against the stage in both. The board draws the frame; a mockup file never draws a device.
- **The plan's Mockups tab** is a `TabCard` with the same preview and a collapsible Build notes card (Keep and Free, plain text).
- **There are no mockup settings.** Every project is drawn at all four devices and in both modes, and the coding tool builds the project's kit (colours, fonts, logo, icons) by itself and saves it with `mockup_kit_set` or the bridge command, with no screen for it. The old tables (`mockup_project`, `mockup_template`) are kept and unused. An old `/mockups/settings` address redirects to the Mockups page.
- **Faithful rendering.** A mockup must look like the product: the project's real icons as inline vector images from the kit's sprite, the real font files embedded as data addresses under the kit's family names, and colours from the kit's tokens only. The board adds the kit head where the mockup carries `<!--afb-kit-->`, and checks every saved mockup and kit, answering with plain words warnings (an address the sandbox blocks, an icon font with no file, a font that is not the kit's, emoji used as icons, colours that are not the kit's). No new colour token and no new font.
- **The public page** (`/m/{token}`) is outside the organisation shell: the logo lockup, who shared it, a sandbox notice, the preview with its switches and a footer. One plain page answers a wrong, off, trashed or private-plan link.
- **A mockup file runs sandboxed**: no cookies, no storage, no network, no same origin. A pin is a number in a ring in the accent, drawn by the mockup itself so it stays on its element. The board sends the frame only each pin's id, place, number and whether it is done, plus the accent as `#rrggbb`, never a comment's text or author. A pin belongs to the device it was placed on and shows only there (an older pin with no device shows on every device).
- **Pinned comments.** Two buttons sit on the right of the device switch: Comments (with the open count, `aria-expanded`) and Add a comment (`C`, `aria-pressed`). While placing, a click drops a pin and a comment box opens beside it on the stage (380 px wide, 16 px padding; Ctrl or Cmd+Enter posts, Esc cancels, the pin can be dragged before posting; Post is the one primary button while it is open; on a phone the shortcut hint is dropped). `C` and Esc are ignored while typing, with a modifier held, on repeat and while a dialog is open, and they also arrive from the frame because the page that has focus gets the key. Esc works in layers: the box, then placing, then the drawer.
- **The comments drawer** (`MockupComments`) is not modal: no backdrop, no focus trap, no scroll lock, so the pins and the frame stay usable (`ResponsiveModal` is modal and cannot be used). It is 340 px wide and slides over the right side of the stage, so the preview never loses width, and it is a bottom sheet with a handle below `md` whose header opens and closes it. It filters Open, Resolved and All, lists the comments of the device on show (numbers are the comment's place among all the comments of the version), pulses a pin on the mockup when its comment is picked and opens its comment when a pin is clicked, resolves and reopens (people who can write), and ends with one row for another device and one for another version that still have open comments. New pixel values with their reason: drawer 340, comment box 380 (a four-line form needs more than a popover), marker 26 (a 44 px tap target is not possible inside a scaled page), the 0.3 s frame transition (owner's request).

## Continue with

`ContinueDialog` (`src/lib/board/`) hands an item to the person's coding tool: Claude Code by default, or Codex, Gemini CLI or a plain copy. The tool and the usual way are set per person in Your settings, "Continue with".

- It shows as a small secondary button next to "Change status" on the item page, and as a small play button on a board card (on hover on a wide screen, always on a phone at 44 px). The card button is a sibling of the card link and never inside it, so a click cannot open the item or start a drag. It is never the primary action.
- The dialog follows the other dialogs: a way picker, one primary button named for the way, and a normal secondary Cancel beside it, right aligned.
- Only a person who can write sees it, and never on a COMPLETED or REMOVED item.
- The web app cannot start a terminal on a PC, so there is no "run" button. The ways are Open in VS Code (Claude Code only), Copy command and Copy prompt. On a touch screen Copy prompt comes first.
- **Free text never goes into a shell command.** The copied command carries only the item reference and fixed words. The title and the address appear in Copy prompt and the VS Code link only, with control characters removed and a length cap. See `src/lib/shared/continue.ts`.

## Background mesh

`src/lib/ui/MeshField.svelte` draws a full page square mesh on a canvas, mounted first inside `AuthShell`'s `<main>`.

- A 48px grid that matches the static grid texture. The crossings ease toward the pointer so lines bend, nearby cells and lines light up, and a pulse of light runs along a random line now and then.
- It fades out toward the bottom with a mask, like the grid texture did, so the lower part of the page stays clean.
- It reads the accent token and re-reads it when the theme changes.
- Performance rules: wide screens only, nothing reactive in the frame loop, pixel density capped at 1.5, paused when the tab is hidden or the page is off screen, started when the page is idle, off under reduced motion, no new dependencies.
- Dropped: a node and link particle network, and particle libraries such as tsParticles (too heavy for the first page anyone sees).

## Checklist for a UI change

1. Looks right in light and dark.
2. Reads colour from tokens, with no literal hex in a component.
3. Uses Poppins for text and Bricolage for bold, through the shared rule.
4. Decorative motion is off under reduced motion.
5. Alignment and widths are even with their neighbours.
6. Keyed lists, labels and focus states stay accessible.

## Tokens and scale

Chosen direction is Graphite (ADR-033). Components read these tokens only. No component carries a literal colour. The scale and its machine form `tests/ui-shots/scale.json` change together.

### Colour, light and dark

| Token           | Light     | Dark      | Use                                    |
| --------------- | --------- | --------- | -------------------------------------- |
| `--bg`          | `#f3f4f7` | `#0c0e11` | Page background                        |
| `--surface`     | `#ffffff` | `#171b21` | Cards, headers, inputs on raised areas |
| `--raised`      | `#eceff3` | `#212730` | Chips, progress track, callouts        |
| `--ink`         | `#14171c` | `#f1f3f6` | Text                                   |
| `--muted`       | `#565d68` | `#a7aebb` | Secondary text                         |
| `--line`        | `#d5d9e0` | `#333a45` | Hairlines and borders                  |
| `--accent`      | `#2563eb` | `#6b9bff` | Primary action, focus, selected        |
| `--accent-ink`  | `#ffffff` | `#071634` | Text on the accent                     |
| `--accent-soft` | `#dde8fd` | `#1a2a4d` | Selected tint, running badge           |
| `--accent-text` | `#1d4ed8` | `#6b9bff` | Accent text on the soft tint           |

Fixed semantic colours, the same for every org palette.

The running badge uses `--accent-soft`. A session that left finished work unrecorded shows a second badge beside it in the warning tone (`Not recorded`), the same size, never inside the running badge and never in the accent.

| Token       | Light     | Dark      |
| ----------- | --------- | --------- |
| `--danger`  | `#c62828` | `#ff7b72` |
| `--warning` | `#a15c00` | `#f0b429` |
| `--success` | `#1b7a3d` | `#4ade80` |
| `--info`    | `#1565c0` | `#79b8ff` |

### Contrast results (WCAG ratio)

| Pair                       | Light | Dark  | Needs        |
| -------------------------- | ----- | ----- | ------------ |
| ink on bg                  | 16.28 | 16.39 | 4.5          |
| ink on surface             | 17.76 | 15.32 | 4.5          |
| muted on bg                | 5.72  | 7.31  | 4.5          |
| muted on surface           | 6.24  | 6.83  | 4.5          |
| accent-ink on accent       | 5.17  | 6.61  | 4.5          |
| accent on surface          | 5.17  | 6.58  | 3 (non-text) |
| accent-text on accent-soft | 5.44  | 5.23  | 4.5          |
| danger on surface          | 5.62  | 7.06  | 4.5          |
| warning on surface         | 5.19  | 9.55  | 4.5          |
| success on surface         | 5.39  | 10.22 | 4.5          |
| info on surface            | 5.75  | 8.58  | 4.5          |

The plain accent on the soft tint is 4.19 in light mode, so text on the soft tint uses `--accent-text`. Phase 2 enforces this in the palette generator for any org colour.

### Scale per level

Screens are judged against these values. Sizes are CSS pixels. Desktop is 1440 wide and phone is 390 wide. A value off this table, or larger than its sibling at the same level, is a "to fix" flag.

| Level            | Desktop                                              | Phone              | Notes                                                                                             |
| ---------------- | ---------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `title`          | 28 / 600 / line 36                                   | 22 / 600 / line 30 | One per page, in the page header                                                                  |
| `section`        | 18 / 600 / line 28                                   | 18 / 600 / line 28 | Card, panel and tab headings                                                                      |
| `body`           | 15 / 400 / line 24                                   | 15 / 400 / line 24 | Default text. Nothing a person must read is smaller than 13                                       |
| `label`          | 13 / 500 / line 18                                   | 13 / 500 / line 18 | Field labels, table heads, helper text, the metadata under a title                                |
| `badge`          | 12 / 600                                             | 12 / 600           | Status badges and counts only (`data-badge`, `data-count`), the one exemption from the 13 minimum |
| `button-primary` | height 40, 15 / 500, radius 8                        | height 44          | One per view                                                                                      |
| `button`         | height 40 (32 compact in tables), 15 / 500, radius 8 | height 44          | Secondary actions                                                                                 |
| `button-icon`    | 40 x 40 hit area, 20 icon                            | 44 x 44, 20 icon   | Icon only, always with an aria-label                                                              |
| `input`          | height 40, 15 / 400, radius 8, padding 12            | height 44          | Text fields and selects                                                                           |
| `card`           | radius 12, padding 16, 1px `--line`                  | padding 14         | No shadow                                                                                         |
| `row`            | table row padding 10, list row height 48             | height 56          | Lists and tables                                                                                  |
| `icon`           | 16 inline, 20 in buttons, 24 in empty states         | same               | Phosphor, regular weight                                                                          |
| `image`          | thumbnails 120 x 80, radius 8                        | 96 x 64            | Attachments and shots                                                                             |

### Spacing and shape

Spacing steps are 4, 8, 12, 16, 24, 32. Radius is 6 (chips and small controls), 8 (buttons and inputs), 12 (cards and screens), 999 (badges and switches). Touch targets are at least 44 px on a phone and 40 px on a desktop. Focus ring is 2 px `--accent` with 1 px offset.

### Container (ADR-003)

One frame holds the navigation and every page: max width 1440 px including the gutters, gutters 32 px on a desktop and 16 px on a phone, centred. It is `PageFrame` (`data-testid="page-frame"`; the navigation uses the same component as `nav-frame`). No page has its own width. A screen that reads best narrow keeps the frame and uses columns inside it. The page header (`PageHeader`) is the same on every page: title, one line of context, actions on the right. `tests/checks/frame.spec.ts` checks the left edge and width on every screen.

### Disclosure (ADR-004)

A page does one job. Secondary actions live in a popover, creation in a modal or a drawer, detail in the side drawer, and long pages are split into tabs. Settings show one section at a time in a side tab column (`SettingsShell`, the tab is `?tab=<section id>`). Board filters are a Filters popover whose state is in the URL.

### Overlay contract (ADR-010)

- A dialog is a centred modal on a wide screen and a bottom sheet on a phone. A drawer (`ResponsiveModal variant="drawer"`) is a right hand panel from 640 px up and a bottom sheet below it, switched in CSS only, so there is no layout flash.
- Escape closes only the topmost layer. The background does not scroll while one is open. Focus moves in on open and returns to the opener on close. A modal or drawer traps Tab.
- Every icon only control has an `aria-label`. Touch targets are at least 44 px on a phone.
- Anything a person can link to has a URL (a tab, a filter, a view). Back closes a drawer that has a URL.

### Visuals (ADR-005)

Progress, order, time and people are drawn. `ProgressRing` shows an item's percent with a fixed status colour (info while in flight, success when done) and never the org accent. `Avatar` shows a person or a logo tile with initials as the fallback. `Illustration` is the one illustration style (rounded shapes in the surface, line and accent tokens), used only on empty, error and welcome screens and beside the sign in form.

### Structure and texture (round two)

- Surfaces are the page (`--bg`), the header band (`--band`, a tint of the accent on the surface), the card (`--surface`) and the translucent top bar (`--bar`).
- Elevation is two shadows, `--elev-1` for cards and rows and `--elev-2` for the bar once the page scrolls and for the sign in card. Overlays keep `--shadow-pop`.
- The background is three quiet layers behind the page, all mixed from the accent so an organisation palette carries through: an aurora of two glows (`--glow`, `--glow-2`), a faint grid (`--grid`) and a paper grain (`--grain`). Dark mode raises each a little. Worst case contrast of muted text on the strongest glow is 6.4 to 1 in dark and 5.1 to 1 in light.
- Fields lift with `--elev-1`, and on focus take an accent border and a four pixel `--accent-soft` ring instead of an outline. A password field has a reveal button, and the sign in fields carry an icon.
- Motion helpers in `app.css`: `.enter` (fade and rise), `.stagger` (rows enter in turn, `--i` sets the order), `.lift` (a hovered card rises two pixels) and `.press` (a pressed control settles). All are off under reduced motion.
