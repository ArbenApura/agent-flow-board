# Mockups made of parts

A mockup is one HTML page for people and the browser. For the agents that build from it, the page is cut into named parts that can be read one at a time, and what only a machine writes is kept out of the reading. Nothing here changes how a single HTML file is published: that stays valid.

## The owner's rule

The agent must read the actual mockup source, because the source holds what a picture cannot: animations, transitions, timing and behaviour. So the read gate (`MOCKUP_UNREAD`) counts authored characters. The outline, the pictures, the rendered trees and the seeded inventory are aids and never count as a read. Only machine output is excluded: embedded picture data, an icon sprite and generated style (`<style data-afb-generated>`).

## Parts of a page

`src/lib/server/mockups/segments.ts` cuts any page into parts that cover it once: `head`, `style:n`, `behavior:n`, `screen:<key>`, `surface:<id>` (a `<template id="t-...">`) and the `shell` around them. `mockup_get` lists them on its first reply (with start, end and size) and reads one with `part`; `since` an older version lists which parts changed. The derived assets of a version store the parts and the excluded ranges, and a version stored before parts existed is cut on the spot (and keeps the whole-page rule).

## Bundles

A bundle is a folder with `mockup.json` that lists `{ kind, key, file }` parts, pushed with `agent-flow-board mockup bundle <dir>` or the `mockup_bundle_publish` tool:

| Kind                | What it is                                                                        | Where it goes in the page                   |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| `skeleton`          | The shell, with slots. Left out, the project shell is used                        | The page itself                             |
| `head`              | Charset, title, the `afb-config` tag, the kit marker                              | `<!--afb-part:head-->`                      |
| `style`, `motion`   | Authored CSS. `motion` holds keyframes, easing and the reduced-motion rule        | `<!--afb-part:styles-->`, each in `<style>` |
| `screen`, `surface` | Markup of a screen, or of a sheet or dialog (a `<template>`)                      | `<!--afb-part:screens-->`, `…surfaces-->`   |
| `fixtures`          | Sample data as JSON                                                               | `<!--afb-part:fixtures-->`                  |
| `behavior`          | The page script                                                                   | `<!--afb-part:behavior-->`, in `<script>`   |
| `contract`          | What is bound, kept or free, the app pairing, widths and states (never in a page) | Stored with the version                     |

The server joins the parts into the one page that is stored, served on the mockup host and read as any version (`src/lib/server/mockups/compose.ts`), and keeps each part as a file (`mockup_part`). A part with no slot in the skeleton is refused by name. `mockup pull <id> --parts <new folder>` writes the same folder back.

The project shell is the skeleton shared by every bundle that sends none: `mockup shell <file> --project <key>` or `mockup_shell_set`. It needs the screens slot.

## Tailwind at push

`mockup push` and `mockup bundle` take `--tailwind-entry <the project's entry CSS>`: the bridge runs the project's own installed Tailwind 4 with that entry as input, the app scan off and the page as the only source, and stores the result as a generated style. Class names must appear as whole strings in the page, also inside its script. For another tool, build the CSS with the project's command and pass `--style-file`.

## The contract

One file per version instead of three places that said the same thing (the Keep and Free notes, the design brief's Free list, the compare manifest). `refs` give each `data-ref` a binding (`bound`, `keep` or `free`, a free line with its reason and optionally one property), `pairs` pair a `data-ref` with the app selector, `widths` and `states` say what matters and how each state is reached. The notes are written from it when none are sent; `check compare` reads its pairs, free lines and states from the board and the command line only adds to them.

## Pictures and rendered trees

`--renders` (with `--widths`, `--render-states`) opens each declared screen at each width after a push and saves a picture and the rendered element tree (`data-ref`, text, box, whitelisted styles) with the version. They see markup built by script, which the server's outline of the raw HTML cannot. `mockup_get` returns them with `tree: true`.

## Motion

Inspect and compare read the transition and animation properties of both sides: durations within 20 ms, the same easing, an animation present on both sides or neither. `check compare --reduced-motion` opens both sides with the reduced-motion preference. Stagger order, drag feel and loading hold times are read in the source and checked by hand.

## The seeded inventory

`mockup_inventory` (and `GET /orgs/{org}/mockups/{id}/inventory?scopes=today,surface:lab`) lists, from the source, what a phase has to account for: regions, texts, states, what opens what, and a line for every transition and animation with its trigger, property, duration and easing, plus pointers into the script. The agent reads the source, adds what the seed cannot see and marks each line built, free or differs.

## Weight

The publish answer carries `readCost` (parts, authored characters, a token estimate, the reads it takes) and warns about pictures embedded in the page, a large hand-written stylesheet next to a kit, a heavy script, keyframes buried in generated CSS, markup repeated again and again, and states no URL hook can open. The mockup page shows the same cost in its Source card.
