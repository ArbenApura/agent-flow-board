# Flow: reading and following the plan's mockup

Read this before any visible code when the plan has a mockup (`SKILL.md` section 3, step 3a). The stop rules and the binding rule stay in `SKILL.md`; this file holds the procedure. A harness with no skills folder reads it with `workflow_get` name `flow` file `mockup-read`.

A plan has a mockup when `work_start` (or `session_start` with an item) answers with `mockups`, or `mockup_list` with the item returns one. Check again at the start of every phase that touches a screen, because one can be linked after the plan was approved. This holds for the lite flow too.

## Read all of it

1. `mockup_get` with your `sessionId`. The first call returns the Keep and Free notes, the open pins (a pin the people marked resolved needs no change) and the first part of the HTML. `outline true` adds the outline, pictures come only when a screen is named or `includeImages` is true (the reply says how many it left out), and `tree true` adds the rendered trees with their quality findings.
2. Read the actual mockup HTML in full: call again with `htmlOffset` set to `nextOffset` until `nextOffset` is null, or part by part (`part`, then `htmlOffset` inside it; the first reply lists the parts and their sizes, and `since` an older version lists the parts that changed). The HTML is the source: it holds the animations, transitions, timing and behaviour a picture cannot show. Only machine output (pictures, an icon sprite, generated style) is excluded and needs no reading.
3. Notes, pins, outline, pictures, rendered trees and the seeded inventory are guides. None of them counts as a read, and a screen is never built from the notes alone.
4. Several mockups: read every one to the end and write a `Mockup read` line for each that covers a screen of the phase. `work_start` says `moreMockups` or `mockupsUnavailable`. A page fetched from the mockup's link is not a recorded read. The procedure for several mockups, what the server records of a read, and a harness with no `mockup_get` are in `reference.md`, under "Reading several mockups".
5. While a mockup of the plan is unread, the replies of `work_start`, `step_done` and `record` carry a `mockupNotice`, and the call that would close the last open step of a phase is refused with `MOCKUP_UNREAD` and writes nothing (a phase with no visible change too: read the mockup once). Never unlink, trash or replace a mockup to pass that check: the server refuses an agent that does.
6. A mockup that cannot be fetched, or cannot be read to the end even in parts and with a subagent reading some of them, is reason 4 to stop: record it in `blockers`, say so, and do not build the screen without it.

## Study it before you build

In a call of its own (a refused `step_done` saves none of the sections sent with it), write a `Mockup inventory` block in the `design-brief` section, creating the section when the plan has none. One line for every screen, region, component, state (empty, loading, error, hover, open), text string, order, interaction and motion (every transition and animation with its trigger, property, duration and easing) the source shows. `mockup_inventory` seeds the list for the screens and sheets of the phase; read the source, add what the seed cannot see, and keep nothing the mockup shows off the list.

## Follow it

The mockup's tier is the `fidelity` of its `afb-config` (`mockup_get` and `mockup_list` return it; none means `high`). **`wireframe`:** structure, layout order, text, states and interactions are binding; every colour, spacing, size, type, icon and component choice is free, so build with the project's real components and tokens and never copy the grey boxes. **`screenshot`:** only the numbered callouts in the page body are binding (what changes, where); the rest of the picture is the real screen as it is today. The inventory lists the callouts and the read gate counts them. **`high`:** as follows.

The mockup is the spec for what a person sees: its structure, layout order, text, states and interactions are binding, whatever the notes say. Build it with the project's real components and tokens, never by copying the mockup's own markup. Always free, with or without notes: colours, spacing, sizes and type that resolve to the project's tokens and scale (the repo's design rules and the user's saved preferences win on those), and a real component standing in for a drawn one that does the same job. The Free notes add to what is free; the Keep notes point at what matters most and never make anything else optional.

## Check it at the end of the phase

Mark every inventory line `built`, `free` (say why: a token, a real component or the Free note) or `differs`. Then write one line for the phase in the `design-brief`: `Mockup read: <mockup id> v<n>: HTML read in full, inventory <n> lines, built <n>, free <n>, differs <n>`. A visible step is not done without the inventory and that line; `/flow-critic code` and `/flow-audit` check both against the HTML and the server's record.

A line that differs in something binding is never dropped silently. Collect them through the phase and show them as one list at the end of the phase, never one stop for each. With none, say nothing and go on. With some, that one list is the stop: show each line with what you built instead and why, and wait for the user's word before the next phase.

A mockup you drew yourself in this run is never your own reason to stop: when it shows something the plan does not contain, take that out, publish a new version, read it and go on.
