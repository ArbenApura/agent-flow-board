# Browser checks with afb-checks: do it all, ask four things at most

The tool lives in `C:/Users/Admin/Desktop/afb-checks`. Read its `AGENTS.md` once: it is the rulebook (what you may edit, every command, how a check and a recipe are written). This skill says how to take one check from words to a result on the board with nobody typing anything.

> [!IMPORTANT]
> Edit only `afb-checks/checks/` and, through its commands, `afb-checks/data/`. Never edit `template/` (every command refuses to run if it changed). Never open, copy or print anything in `data/profiles/` or the profile folder. Never put a password, token or cookie in a check. Never point anything at the 5433 database, port 5180 or port 5190, and never run a check against a live site.

## The only questions you may ask the person

Everything else you decide and record. Ask one of these only when its situation really comes up, in one plain sentence, with the exact command to run:

1. **The one-time connect code.** `runner_status` says no tool is connected for the project. The person runs `node afb-checks.mjs connect --server <board address> --org <org slug>` once and approves it on the board.
2. **The one-time grant.** A project command says `Agent mode is off` or the grant expired. The person runs `node afb-checks.mjs grant --roots <folder that holds the repos>` once (valid 30 days). Then register the project yourself.
3. **A command outside the guardrails.** A project command answers `Not allowed without the keyboard (<rule>)`. Quote the rule and the line, and let the person run the same command without `--auto`.
4. **Anything touching the 5433 database, ports 5180 or 5190, or a live site.** Never do it. Say what was asked and stop.

A failing check is a finding to report, not a question.

## Take one check from words to a result

1. Name the item and the check key (a manual check such as `M1`). Start the session and claim the item as usual (`session_start`, `work_start`). If the item has no manual check for it, add one with `plan_add_checks`.
2. Write `checks/<ITEM-REF>/<CHECK-KEY>.mjs` in the tool folder with `step(name, fn)` and `shot(caption)`. A check gets `page`, `step`, `shot`, `expect`, `log` and `baseUrl`, and nothing else.
3. Save **the same text** on the board with `check_save` (item, check, script, target `preview`). It also marks the manual check automatic. The tool runs only the local file; if the board's text differs, the report says so.
4. Ask `runner_status` for the project. If a tool is online, go on. If it says the tool is connected but not running, run `node afb-checks.mjs service install` (it starts the worker with no window and at every sign-in). If none is connected, that is question 1.
5. Make sure the project is registered: `node afb-checks.mjs status`. If it is not, register it yourself: `node afb-checks.mjs project <KEY> --auto --repo <repo folder> --recipe --database tool` for a repo with a `.afb-checks.json` recipe (AFB has one), or `--build "yarn build" --start "yarn preview --port {port}" --database none` for a plain app. If the repo has no recipe and needs a database or settings, write `.afb-checks.json` first (see `AGENTS.md`). If it answers about agent mode or a guardrail, that is question 2 or 3.
6. Ask for the run and wait in one call: `check_run` with `item`, `check`, `target` `preview`, `step` (the plan step it closes) and `wait` 90. If `finished` is false, call `check_wait` with the run id until it is. An unavailable run answers at once with a code.
7. Read the result. A pass on the preview closes the check and the step when the run is tied to a commit; otherwise the board records it as unverified and says so. A fail is a finding: report what failed and where. The pictures are on the run as evidence.
8. When a run ends with a **code**, apply its `fix` line and ask again, once. The codes are `PREVIEW_ENV_MISSING`, `PREVIEW_NEEDS_OWNER_URL`, `PREVIEW_HOST_UNREACHABLE`, `PREVIEW_PORT_BUSY`, `DB_NOT_THROWAWAY`, `TOOL_OFFLINE`, `TOOL_OUTDATED`, `TARGET_UNAVAILABLE` and `RUN_TIMED_OUT`. If the same code comes back, stop and tell the person what the fix line says and what you tried.

You can run a check on this machine without the board too: `node afb-checks.mjs run <ITEM-REF> <CHECK-KEY>` (exit code 0 pass, 1 fail, 2 could not run; the last line is `RESULT <path>`).

## UI shots

`node afb-checks.mjs shots --project <KEY> --pages /a,/b [--siblings /c]` takes pictures at 1440 and 390 in each theme and reads the sizes, read only. `measure --project <KEY> --pages /a,/b,/c` (3 to 15 pages) writes the design scale file. A queued UI shots run from the board is taken by the worker too.

## Limits to say out loud

- A pass closes a step only when the tool could tie the run to a commit (the project's repo folder). Otherwise the board records it as unverified.
- The preview runs the repo's own code from a private copy under `data/worktrees`, never from the folder a person's preview serves, with its own throwaway database on 127.0.0.1. `node afb-checks.mjs clear dbs` removes those, by the names it recorded, and nothing else.
- Writes the page tries are stopped and counted. Only a person runs with `--allow-writes`, and only on a site made for testing.
- Standing owner override: plans do not get browser check steps. Run a check only when the person asks for one.
