# Flow: the design brief and the Screen spec

Read this when a plan adds or visibly changes a screen, dialog, form, component layout or email layout (`SKILL.md` section 2, step 4a). The stop rules stay in `SKILL.md`; this file holds the detail. A harness with no skills folder reads it with `workflow_get` name `flow` file `design`.

## The `design-brief` section

Write it before you present the plan. Every line names its source. It holds:

- **User preferences:** the user's own words in this session, the repo rulebook, saved memory where the harness has it, and earlier plans from step 2a, including what the user rejected or dropped.
- **Brand identity:** the design document, tokens, fonts, logo, palette and tone of voice. Read the values from the repo, never from memory.
- **Inspiration from what exists:** 2 to 5 similar screens or components in this repo, each with its file path and what is copied (structure, sizes, spacing, states, wording). An outside reference only when the user names one.
- **Reuse and new:** the existing components reused, and for each new element the reason nothing existing fits.
- **Rejected looks:** what must not appear, from the user's history and the brand rules.
- **Screen spec:** below.

(example) the design document is `DESIGN.md`, the tokens are in `src/lib/theme/` and the components in `src/lib/ui/`.

**Strictly from the sources.** A visible choice with no source copies the nearest similar component. With no source and nothing similar, never invent it and never settle it with a recommended default: write it as an open line of the hand-over ("not built until you answer", with a "Checked" line) and do not ask it with a question tool. A plan with no visible change, or a fix that restores the existing look, writes one line in the spec saying so and has no brief.

## Screen spec

A new screen, or a change of structure or behaviour, has no mockup unless the user asked for one, so the brief says what the screen is and does well enough to build it without guessing. One block per screen, dialog or form, written as text:

1. **Layout:** the ordered structure top to bottom and left to right, the container, the sibling file it copies (path), the tokens and scale values for spacing and size. A small text sketch is allowed for a layout that is not obvious.
2. **Responsive:** what changes at 1440, 820 and 390 (what stacks, hides or becomes a sheet or drawer, the tap target size).
3. **States:** only the states this screen has, each with what the person sees: default, hover, focus, pressed, disabled, loading, empty, error, long list.
4. **Copy:** every label, button, empty message and error text, written out. Wording nobody has settled is an open line of the hand-over, not a default.
5. **Motion:** for each transition or animation the trigger, property, duration, easing and reduced-motion behaviour. The project's existing motion is the default; a new one needs a reason.
6. **Interaction:** keyboard order, where focus goes after open and close, what Esc does, what is saved and when, how to undo.
7. **Data:** sample rows for the realistic cases (short, long, missing value).
8. **Acceptance looks:** 3 to 6 lines a person or the end-of-plan screenshot can check ("the title and the primary button share a baseline at 390").

**Depth follows risk.** The full block is for a new screen, a new pattern or a change of structure or behaviour. A tweak to a screen the person already approved (spacing, wording, colour, size or order) is one line in the brief. A state, motion or copy line the screen does not have is left out, never filled in to look complete.

## Mockups (only on the user's word)

A mockup costs many tokens and versions, so it is never offered, suggested or recommended, and the hand-over has no mockup line. It is made only when the user types `/flow-mockup` or asks for one in their own words (a yes or no already given in this session counts). A build instruction or a bare go never means a mockup.

- **Draw it at once** in the same turn, then carry straight on: into the build when the message held an explicit build instruction, else to the hand-over. Never end a turn only to show a mockup, never ask whether to continue after one. A message that names `/flow` and `/flow-mockup` with no build word: write the plan, draw and publish the mockup (no `work_start`: a mockup is planning work and holds no claim), then end at the hand-over.
- **Build it with `/flow-mockup`** (a harness without the skill: `workflow_get` name `flow-mockup`). It publishes one interactive HTML page to the board (a Mockups tab on the plan, a project Mockups page, a viewer with history and pinned comments). One version unless the user asks for more. It is planning work, never a counted step and never a file in the repo.
- **A build follows the mockup of its plan.** Link it from `design-brief` and carry on. There is no approval of a mockup and no pick between versions; the user looks, comments with pins and may ask for a new version. Once linked, it binds the build (`SKILL.md` section 3, step 3a).
- **Without a board that hosts mockups** (`mockup_publish` and `mockup_get` not offered) and a plan with no mockup, do not mention mockups. A plan that already has one is still bound by step 3a.
