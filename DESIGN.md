# Design

How Agent Flow Board looks and moves, and what was tried and dropped. Read this before changing any screen. Colour tokens are in `design/tokens.md`, the size scale in `design/scale.json`.

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
- **Class names are written in full.** Tailwind builds only the classes it can read in the source, so a class made from a variable (`${prefix}:hidden`) is never generated. The rail state is the `side-collapsed:` variant, defined in `src/app.css`.
- **The top bar** holds the breadcrumb, search (organisation pages) and the account menu. Search is not in the sidebar.
- **An organisation is shown as `OrgTile`**: its logo, or two capital letters on one of four theme tints chosen from its address, the same everywhere.
- **The loading placeholder draws this shell** (`#afb-boot` in `src/app.html`): the rail, the top bar and the shape the page had last time. A new page shape adds its own block there and sets `data-org` in the boot script.
- **Database round trips are a design input.** The database can be far from the person developing, so a page that makes many queries in a row is slow. Run independent loads in parallel and avoid a transaction for a check that rarely changes.

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
