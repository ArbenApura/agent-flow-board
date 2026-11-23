---
name: flow-critic-screen
description: Use only when the user asks for a per-screen visual critique of a design mockup or a built UI ("one critic for each screen", "check desktop, tablet and mobile", "render the pictures, do not just read the code"), on Agent Flow Board (screen mode of /flow-critic). The lead takes real pictures of every screen at phone, tablet and desktop widths in the harness browser, gives each screen its own read-only critic that LOOKS at the pictures, then verifies, fixes and republishes. Loaded through /flow-critic; also usable when the user types /flow-critic-screen.
---

# Flow Critic: one critic for each screen

> **Shared rules first.** This module is one half of `/flow-critic`. Before you dispatch anything, read `/flow-critic` (in a tool with no skills: `workflow_get` name `flow-critic`) for the session and project key, the repo rulebook, the shared rules in its section 2 (convergence, dispatch), the verify, triage and resolve rules in its section 5 and the red flags in its section 6. **One exception to its section 2: the subagent count is one critic for each screen, not 3.**

`/flow-critic-mockup` reviews a mockup with 3 critics split by lens. This module is the **per-screen** variant: every screen (with its sheets) gets its own critic, and each critic judges **rendered pictures** at phone, tablet and desktop and the **consistency between them**. A critic never drives a browser: **the lead takes the pictures, the critics look at the files.**

Files in this skill:

- `SKILL.md` (this file): the steps and the report.
- `critic-brief.md`: the standing brief and output format every screen critic gets.

## 0. Before you start

1. Say the mode in one line ("Per-screen visual critique of <mockup or app>, N screens, 3 widths").
2. Find what is being reviewed: a published mockup (`mockup_list`, then read its HTML with `mockup_get` to the end, or with the bridge `agent-flow-board mockup pull <id> --out <file>`), a local mockup file, or the running app as the repo rulebook allows (never start, stop or restart a server the user started, though opening the address the repo rulebook names for it is allowed, and never a database they keep). Read the plan's `design-brief` and the real sibling screens the mockup copies.
3. Settle the **screen list**: one entry per screen. A page and the sheets, dialogs and popovers that open from it are ONE screen (they share a critic). Navigation and shell (sidebar, rail, tab bar, top bar) are their own entry. Documents that live outside the app shell (a print page, a public page, an email, a display) are each their own entry. Do not merge unrelated screens.

## 1. Take the pictures (the lead does this)

Use the browser protocol of `/flow` section 3 step 5a (the harness browser: open the page, set the width, scroll, click through states, sign-in handoff, resetting the viewport at the end). Widths are phone, tablet and desktop: the repo rulebook's widths for the app (else 390, 820 and 1440), the board's device widths for a mockup (408, 820 and 1280).

1. Work in a temporary folder **outside the repo** (the session scratch folder). For a mockup, make the local copy with the kit head in place of the marker as `/flow-mockup` says, and add a "still" style (`*{animation:none!important;transition:none!important}` and any reveal or stroke-draw reset) so the pictures show the final state. Count-up numbers and similar script animations can still be caught half way: list them as known artefacts for the critics.
2. Take one picture of every screen at each width with a tall viewport so the whole page shows; sheets and dialogs with a normal-height viewport. Also take the other states the plan names (loading, empty, error, no access, each variant) at the phone and the desktop width. Name each file `<screen>-<state>-<width>.png`.
3. **Phone pictures can lie.** A headless browser can lay a page out wider than the phone width and crop the right edge. Check the right edge of every phone picture; when one is cropped, confirm the layout in the harness browser at that width and tell the critics which picture to distrust.
4. **Look at two or three pictures yourself** before dispatching. If they are blank, half-animated or the wrong screen, fix the render first: a critique of bad pictures is worthless.

**When the harness browser cannot be driven**, use a headless Chromium from the command line, one call for each picture (the address of a local file or a local web page; the window size is `<width>,<height>`):

- Windows (PowerShell): `& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=4000 --window-size=408,1900 --screenshot=<out.png> <url>` (or `msedge.exe`, or the `chrome-headless-shell` that Playwright installs under `%LOCALAPPDATA%\ms-playwright`).
- macOS: the same flags with `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.
- Linux: the same flags with `google-chrome` or `chromium`.

**No browser and no headless Chromium at all: no screen critics.** Say so in one line, review the same work with `/flow-critic-code` (or `/flow-critic-mockup` for a mockup, reading the HTML against the repo) and name the limit under "Not verified". Never dispatch a screen critic without pictures.

## 2. Dispatch one critic for each screen

1. Copy `critic-brief.md` into the scratch folder and fill the three placeholders at its top (pictures folder, source files, known artefacts). The brief holds the standing rules and the output format, so each prompt stays short.
2. Send the critics in one message, **one `Agent` call each, at most 8 per message** (the rest in a second message), `subagent_type: "general-purpose"`, no `model`. Each prompt names: the brief path, the screen, the **exact picture file names** (all widths, the sheets, the states), 3 to 5 sibling pictures for consistency, the real source files to compare with, and 3 to 6 things to look at hardest for that screen. A critic opens the pictures with the Read tool.
3. Do not give a critic your own conclusions. Wait quietly; the notifications arrive by themselves.

## 3. Verify, triage, fix

1. Open the picture a `HIGH` cites and confirm it. Refute what the pictures or the real source do not show. A finding that the mockup differs from the real product usually means: fix the mockup, or record an open line when the repo rules and the real screen disagree (say which you followed).
2. Collect all findings first, then fix in one batch. Typical cross-screen fixes: one column template for table rows, equal state cards, one pattern for a repeated element, one header system, tap targets of at least 44 px, one set of labels at every width.
3. Take **all** the pictures again, look at the ones that changed, check that nothing scrolls sideways at the phone and tablet widths and that no tap target is under 44 px on every screen and state, then publish as a NEW VERSION of the same mockup (`/flow-mockup`; never a second mockup) and refresh its `Fidelity:` note with what was measured and the critic count. A built app is fixed in the code as the plan allows.
4. `record` one log line on the plan when the work belongs to one. Do not commit or push. Delete the pictures and reset any viewport you emulated.

## 4. Report (short)

```
Per-screen critique: <mockup/app>, <n> screens, <n> critics, <n> pictures, widths <phone/tablet/desktop>
Fixed: <HIGH and MEDIUM themes, one line each>
Refuted: <count>
Open for you: <decisions that are the user's, rule conflicts>
Not verified: <what could not be looked at>
```

## Never

- Dispatch a critic without pictures, or let a critic judge only the code.
- Merge unrelated screens into one critic when the user asked for one each.
- Treat a green script as the review: the pictures are the review.
- Let a critic edit anything in the repo, drive a browser or call the board, or leave a dev server or an emulated viewport running.
- Publish a version you did not take pictures of again and look at.
