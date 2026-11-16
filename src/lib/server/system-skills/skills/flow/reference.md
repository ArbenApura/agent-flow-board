# Flow reference: the lite flow, the model and the tools

This file is the reference text of the `flow` skill. The rules are in `SKILL.md`; the text below was moved here word for word and in its order, so `SKILL.md` stays short. Read it when you take the lite flow, when you need a field, key format, status, tool or error name, or when you read several mockups (the `flow` text, section 3 step 3a). A harness with no skills folder reads it with `workflow_get` name `flow` and file `reference`.

---

## Lite flow (a plan of 1 to 3 steps)

The choice rule and the first sentence stay in `SKILL.md`: use the lite flow when the plan has 1 to 3 counted steps, or when the user says "lite" or "quick". The lite flow changes how many calls the plan costs, never a rule:

- **Same as the full flow:** section 0 (session, rules, skills notice, `work_start` before any edit), the approval gate (section 2 step 7: a plan of 1 to 3 steps ends with the same hand-over (the choice card where the harness has a GUI question tool, otherwise plain text), no question in the text, and waits for a go unless the user's own words already say build), `step_done` after each step, the lessons before the last step, `work_stop` at the end, every safety rule of sections 5 and 6, the untrusted-text rules, the web readiness statement of section 2 step 7 for a web app with no checks set up, the mockup rule of section 3 step 3a when the plan has a mockup, and the design-brief rule of section 2 step 4a when the change is one a person sees (write it as a `design-brief` section in the spec; a visible change with no source is written as an open line in the hand-over).
- **Skipped:** `related_plans` and the `learned-from` section, `board_validate` after creating (the server validated the plan), the separate `item_update` calls for sections and decisions, and `/flow-critic` or `/flow-interview` unless the user asks.
- **Calls:** `lite_new` (title, `tabName`, 1 to 3 `steps`, the `spec`, optional `validation` and `references`, and every settled decision with its source) creates the item with its sections and decisions in one call. Then the hand-over and the end of the turn; after the user's go, `work_start`, `step_done` for each step as it finishes, and `lite_close` with the `lessons`, the last step keys and one `log` line: it writes the lessons first, marks the steps and releases the claim in one call.
- A lite item that turns out larger is extended with `plan_add_steps` and goes on as a full item, under the rule for added steps (section 3 step 7).

---

## Reading several mockups (section 3, step 3a)

These sentences were part of the first bullet of step 3a ("Read all of it"). The rules of that bullet stay in `SKILL.md`.

- When the plan has several mockups, read every one of them once (the server holds the last step of any phase while one is unread), write one `Mockup read` line for each that covers a screen of the phase, and call `mockup_list` with the item when `work_start` says `moreMockups` or `mockupsUnavailable`.
- The server records what was read (`readChars` and `unreadChars` in a `mockup_get` reply count your own session; `mockup_list` with the item shows the count for the plan, over every session).
- A harness with no `mockup_get` loads the tool, or reads the HTML through the board's API with its session id; a page fetched from the mockup's link on the board is not a recorded read.

---

## 4. The model table (field lists, key formats, states)

These rows of the model table are reference only. The rows that carry a rule (closing another item, retries, versions, the notes the board reads, percent and status) stay in `SKILL.md`.

| Topic | Rule |
|---|---|
| Item | A database row in a project. Fields: `title`, `tabName`, `stream`, `scope` (free text up to 40 characters; the project's own list, if it has one, comes from `project_rules`), `visibility`, `status`, `percent`, `version`. Not a folder, not a markdown file |
| Reference | `<PROJECT KEY>-YYYYMMDD-HHMM` on the UTC minute, for example `PRJ-20261017-0520`. Old `FLOW-` and `FEAT-` ids resolve as aliases and are only named in "Formerly" notes |
| Phase and step keys | Phase key: letters or digits, up to 12. Step key `<phase>.<n>` with an optional lowercase letter, up to 20 characters. Steps default to the next number in their phase |
| Browser checks | Keys `C1`, `C2`… (older ones keep `M1`…). Saved with `check_save`, run with `check_run`, never counted. A pass ticks the step it was started for |
| Step states | `open`, `done`, `waived` (reason required), `superseded` (names the replacing item) |
| Statuses | PLANNED, IN PROGRESS, IN REVIEW, ON HOLD, COMPLETED, REMOVED |
| Documents | Sections `{slug, title, body}` and decisions `{kind adr or settled, number, title, …}`. Each decision kind is numbered on its own from 1 |

### The tools

The two rows that carry a permission rule (talk and files, notes) stay in `SKILL.md` with that rule; the rest of the table is here.

| For | Tool |
|---|---|
| Session and claim | `session_start`, `work_start`, `work_stop`, `work_waiting` |
| Read | `board_brief`, `item_list`, `item_get` (`fields`: steps, checks, decisions, sections), `item_doc` (`section:<slug>`, `phase:<key>`, `decision:<adr or settled>-<n>`), `item_history`, `search`, `related_plans` (earlier plans close to an idea, as digests), `project_rules`, `workflow_get` |
| Plan | `item_new`, `item_update` (fields, sections, decisions), `plan_add_phase`, `plan_add_steps`, `step_update`, `decision_delete` |
| Progress | `step_done`, `record`, `item_status`, `item_trash`, `item_restore`, `undo` |
| Lite flow | `lite_new` (plan of 1 to 3 steps, spec and settled decisions in one call), `lite_close` (lessons, last steps and release in one call) |
| Diagnose | `slow_calls` (admins: the slowest MCP calls of a project and the median, 90th percentile and maximum per tool) |
| Check | `board_validate`; for browser checks `check_save`, `check_run`, `check_wait`, `check_status`, `runner_status` (section 3 step 5a, details in `checks.md`) |

### Errors

`INVALID` (bad input, the message says which field), `NOT_FOUND`, `FORBIDDEN` (the live role or token cannot do it), `CONFLICT`, `STALE_VERSION`, `CONFIRM_REQUIRED`, `COMPLETED_REFUSED` (`open-steps` or `people-only`), `MOCKUP_UNREAD` (the plan's mockup is not read to the end: read it with `mockup_get` and send the call again, with its sections), `RATE_LIMITED` (wait and retry), `INTERNAL`.
