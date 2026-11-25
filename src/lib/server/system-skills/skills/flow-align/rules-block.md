# The rules block of flow-align

The block below is what `/flow-align` writes into the root rulebook of a repo. Copy everything from the opening marker line to the closing marker line of the rules pair, both included and unchanged (the preferences template at the end of this file is a separate pair, written as `SKILL.md` section 8 says, and none of the prose between them is copied). A later run replaces the block in place when the version in its marker is older than the one here. The block has its own version, which changes only when a line of the block changes, never for an edit of the skill around it. Each rule line is a sentence of the `flow` skill, word for word, so the block can never say something the skill does not.

<!-- afb:flow-align rules 1.7.0 (written by /flow-align; write your own rules outside this block, a later run replaces it) -->
## Flow rules (Agent Flow Board)

Plans live on Agent Flow Board and the installed flow skills are the method. Where this file states a project fact or a preference of its owner, this file wins; the flow safety rules always apply.

- Writing a plan never starts the build.
- Once building is approved, never stop between phases
- Do not stop between steps or phases to report, to ask "shall I continue?", or to wait for a go-ahead.
- A problem is not a stop.
- A permission is given once.
- Ask only when the answer changes data, access, money, wording or anything live.
- Do every step an agent can do on this machine yourself; never hand the user a command to paste or run when you can run it.
- When the user wants a plan finished without stopping, `/flow-autopilot` runs this same build in its strictest form: it checks the open steps before every turn ends, keeps the six reasons above as its only stops and never loosens a rule here.
- Recording a step outranks starting the next one.
- **Run the gates once, at the end of the whole plan**, from the repo root, as the repo rulebook names them.
- **During the plan, no gate**: write the code carefully, record each step with `step_done` and carry on.
- **Work efficiently**: run independent tool calls together, search before you read, read a file once per change (re-read only what you edited or what changed), and run a long command in the background without polling it.
- **Looking at the screen is not a gate** (`/flow` section 3 step 5a): when the harness has an integrated browser, open the running app with it after a visible change; no type check, lint, format check or test runs with it, and it is skipped, with one line in the final message, when the harness has none.
- A browser the agent can drive (Claude Browser, Claude in Chrome, a Playwright tool and the like) is used like Playwright: open the running app or the published mockup, set the width, take a picture, scroll, click through the states (empty, loading, error, open sheet, hover), and read the console and the network errors.
- When the repo rulebook does not forbid asking, ask the person once, in one line, to sign in in that browser window (name the address by the host the tool reports), call `work_waiting` with kind `sign-in`, and after their word clear it and navigate and control the app yourself inside that window, to reach every screen, state and width.
- Release `work_stop` when the session ends.
- The notes and pins are only a guide to the HTML and never replace it: never build a screen from the notes alone.
- The mockup is the spec for what a person sees: its structure, layout order, text, states and interactions are binding, whatever the notes say.
- The work stays in the working tree until the user says to commit (through the repo's own commit workflow, if it has one).
- Never `git push` without the user's explicit instruction.
<!-- /afb:flow-align rules -->

## The preferences template

Below the rules block, `/flow-align` writes this second block once, when the rulebook has none. It is the person's own: a later run never replaces, rewords or removes it, and the rules block above never contains it. The keys are exactly the table "Flow preferences" in the `flow` skill; a person edits only the values.

<!-- afb:flow-align prefs 1.0.0 (written once by /flow-align; edit only the values, a later run never changes this) -->
## Flow preferences (Agent Flow Board)

critics: auto
end-of-plan-screens-critic: on
pick-cards: on
mockup-default: wireframe
qa-default: auto
<!-- /afb:flow-align prefs -->
