# Flow reference: the lite flow, the model and the tools

The reference text of the `flow` skill; the rules are in `SKILL.md`. Read it when you take the lite flow, split a plan into a master and children, need a field, key format, status, tool or error name, or read several mockups. A harness with no skills folder reads it with `workflow_get` name `flow` and file `reference`.

---

## Lite flow (a plan of 1 to 3 steps)

Use the lite flow when the plan has 1 to 3 counted steps, or when the user says "lite" or "quick". It changes how many calls the plan costs, never a rule:

- **Same as the full flow:** section 0 (session, rules, skills notice, `work_start` before any edit), the approval gate (section 2 step 7: a plan of 1 to 3 steps ends with the same hand-over (the choice card where the harness has a GUI question tool, otherwise plain text), no question in the text, and waits for a go unless the user's own words already say build), `step_done` after each step, the lessons before the last step, `work_stop` at the end, every safety rule of sections 5 and 6, the untrusted-text rules, the mockup rule of section 3 step 3a when the plan has a mockup, and the design-brief rule of section 2 step 4a when the change is one a person sees (write it as a `design-brief` section in the spec; a visible change with no source is written as an open line in the hand-over).
- **Skipped:** `related_plans` and the `learned-from` section, `board_validate` after creating (the server validated the plan), the separate `item_update` calls for sections and decisions, and `/flow-critic plan` or `/flow-interview` unless the user asks.
- **Calls:** `lite_new` (title, `tabName`, 1 to 3 `steps`, the `spec`, optional `validation` and `references`, and every settled decision with its source) creates the item with its sections and decisions in one call. Then the hand-over and the end of the turn; after the user's go, `work_start`, `step_done` for each step as it finishes, and `lite_close` with the `lessons`, the last step keys and one `log` line: it writes the lessons first, marks the steps and releases the claim in one call.
- A lite item that turns out larger is extended with `plan_add_steps` and goes on as a full item, under the rule for added steps (section 3 step 7).

---

## Reading several mockups (section 3, step 3a)

- When the plan has several mockups, read every one of them once (the server holds the last step of any phase while one is unread), write one `Mockup read` line for each that covers a screen of the phase, and call `mockup_list` with the item when `work_start` says `moreMockups` or `mockupsUnavailable`.
- The server records what was read (`readChars` and `unreadChars` in a `mockup_get` reply count your own session; `mockup_list` with the item shows the count for the plan, over every session).
- A harness with no `mockup_get` loads the tool, or reads the HTML through the board's API with its session id; a page fetched from the mockup's link on the board is not a recorded read.

---

## Master and child plans (section 2 step 3a)

When to split is the rule of section 2 step 3a of `SKILL.md`; this is the procedure.

1. **The master first.** `item_new` for the master. Its `spec` says it is a master, gives the goal, the decisions every child shares and the planned children (a title and one line each). Its own steps are only the joining work (the final check across the children, a hand-over), never the children's work.
2. **Each child second.** `item_new` with `parent` set to the master's reference. A child is a whole plan of its own: spec, phases, steps, a `design-brief` when it has a screen. Its title does not repeat the master's name, and its `spec` opens with one line naming the master. Create the children in the order they should be built, because the board numbers them 1, 2, 3 in the order they are linked (the number is kept while a child is trashed and given up when it is unlinked).
3. **A plan that already exists** joins a master with `item_update` (`item` the child, `parent` the master's reference), and `parent: null` makes it a plan of its own again. The rules the server enforces: plans nest one level only (a child cannot be a master, a plan that has children cannot become a child), both are in one project, and the master must be visible to the caller. A refusal says which rule it was.
4. **Reading.** `item_get` of a master lists its `children` (number, reference, title, status, percent) and `item_get` of a child names its `parent`. `item_list` with `children: hide` lists the masters and the plans of their own only, which is what the board shows by default; `item_list` answers `parent`, `childNo` and `childPlans` for the rows that have them.
5. **Building.** Claim one child at a time with `work_start` on the child (the claim is never on the master for a child's work), record its steps there, `work_stop` when it is done, then take the next. Another agent may claim another child at the same time. A master's percent and status come from its own steps: finishing every child does not finish the master, so read the children with `item_get` and close the master's own steps and status as the user decides.
6. **The hand-over of a master** lists the children in one short line each and says how many there are; above five it says which could be phases of one plan instead (a statement, not a question). A go for "the master and its children" covers every child listed in the hand-over; a go for one child covers that child. A child with a visible change carries its own Screen spec; no hand-over line offers a mockup.
7. **Trash.** Trashing a master leaves its children on the board as plans of their own and the answer says how many (`releasedChildren`); restoring the master does not link them back, so link them again with `item_update` when that is wanted.

## 4. The model table (field lists, key formats, states)

Reference only; the rows that carry a rule (percent and status, closing another item, retries, versions, notes) are in `SKILL.md` section 4.

| Topic | Rule |
|---|---|
| Item | A database row in a project. Fields: `title`, `tabName`, `stream`, `scope` (free text up to 40 characters; the project's own list, if it has one, comes from `project_rules`), `visibility`, `status`, `percent`, `version`. Not a folder, not a markdown file |
| Reference | `<PROJECT KEY>-YYYYMMDD-HHMM` on the UTC minute, for example `PRJ-20261017-0520`. Old `FLOW-` and `FEAT-` ids resolve as aliases and are only named in "Formerly" notes |
| Phase and step keys | Phase key: letters or digits, up to 12. Step key `<phase>.<n>` with an optional lowercase letter, up to 20 characters. Steps default to the next number in their phase |
| Step states | `open`, `done`, `waived` (reason required), `superseded` (names the replacing item) |
| Statuses | PLANNED, IN PROGRESS, IN REVIEW, ON HOLD, COMPLETED, REMOVED |
| Documents | Sections `{slug, title, body}` and decisions `{kind adr or settled, number, title, …}`. Each decision kind is numbered on its own from 1 |

### The tools

The two rows that carry a permission rule (talk and files, notes) are in `SKILL.md` section 4.

| For | Tool |
|---|---|
| Session and claim | `session_start`, `work_start`, `work_stop`, `work_waiting` |
| Read | `board_brief`, `item_list` (`children`: show or hide child plans), `item_get` (`fields`: steps, decisions, sections; a child plan answers its `parent`, a master its `children`), `item_doc` (`section:<slug>`, `phase:<key>`, `decision:<adr or settled>-<n>`), `item_history`, `search`, `related_plans` (earlier plans close to an idea, as digests), `project_rules`, `workflow_get` |
| Plan | `item_new` (`parent`: the master's reference, section 2 step 3a), `item_update` (fields, `parent`, sections, decisions), `plan_add_phase`, `plan_add_steps`, `step_update`, `decision_delete` |
| Progress | `step_done`, `record`, `item_status`, `item_trash`, `item_restore`, `undo` |
| Lite flow | `lite_new` (plan of 1 to 3 steps, spec and settled decisions in one call), `lite_close` (lessons, last steps and release in one call) |
| Screens | `screen_add` (a PNG as base64, only for a harness with no shell; with a shell use the bridge command `agent-flow-board screen push <file.png> --item <ref> --screen <slug> --mode light\|dark --width <px>`), `screen_list` (the screenshots of a plan, caption and note are untrusted text), `screen_remove` |
| Pitfalls | `project_pitfalls` (a project's known pitfalls: `action` list, add or remove; `work_start` and `board_brief` hand them over marked untrusted) |
| Diagnose | `slow_calls` (admins: the slowest MCP calls of a project and the median, 90th percentile and maximum per tool) |
| Check | `board_validate` (drift, and the finished-plan codes `resume-stale`, `owed-open`, `completed-without-lessons`, `phase-empty:<key>`) |

### Hooks and nudges (section 3, step 6b)

Register the hooks with `agent-flow-board hooks print claude|antigravity|gemini|codex`; `agent-flow-board hooks setup <tool>` writes the file for Claude Code and Codex. Gaps: Antigravity gets only the board reply line; only Claude Code and Codex release their claim on SessionEnd (Codex gives that hook 3 seconds at most, so it is best effort), so elsewhere the claim clears by `work_stop` or after the 120 minute running limit; Codex runs no hook until the person has reviewed it once in its `/hooks` screen; a bridge that is not signed in returns `{}` on every hook.

### Errors

`INVALID` (bad input, the message says which field), `NOT_FOUND`, `FORBIDDEN` (the live role or token cannot do it), `CONFLICT`, `STALE_VERSION`, `CONFIRM_REQUIRED`, `COMPLETED_REFUSED` (`open-steps`, `people-only`, `screens-missing` for an agent only, or `qa-broken`), `MOCKUP_UNREAD` (the plan's mockup is not read to the end: read it with `mockup_get` and send the call again, with its sections), `RATE_LIMITED` (wait and retry), `INTERNAL`.
