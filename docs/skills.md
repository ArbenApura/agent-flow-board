# System skills: the flow skills every agent installs

The board ships one set of skills, the `/flow` family. They are not written on the board any more: there are no organisation or project skills, no skill upload, and no MCP prompts. The MCP serves tools only, among them `flow_skills` and `skills_file` (below).

Replaces the custom skills of `AFB-20261018-0622` and `AFB-20261019-0341`. Built under `AFB-20261021-0401`.

## What is in the bundle

`flow`, `flow-task`, `flow-interview`, the four stand-alone critic reviews `flow-critic-plan` (`critic-rules`, `plan-lenses`, `plan-template`), `flow-critic-code` (`critic-rules`, `checklists`, `code-lenses`, `code-template`), `flow-critic-mockup` (`critic-rules`, `mockup-lenses`) and `flow-critic-screen` (`critic-rules`, `critic-brief`) (the old `flow-critic` is retired, and `critic-rules` is the same file in each of the four), `flow-audit`, `flow-mockup` (with its `starter`), `flow-align` (with its `rules-block`), `flow-decide` (decide without asking, from the evidence), `flow-commit` (conventional commits, with or without a plan) and `flow-update-skills` (check, install, update and clean up the skills). `flow` has four supporting files too: `reference` (the lite flow, master and child plans, the model reference rows, the tool table, the hooks gaps and the error codes), `design` (the design brief fields, the Screen spec and the mockup rules), `mockup-read` (how a plan's mockup is read, inventoried and checked) and `screens` (the browser protocol and showing the finished screens). `SKILL.md` carries every stop, refusal and safety rule and names each file, so an agent that never opens them still follows every rule (AFB-20261124-1254); the gates are part of `flow`, and so is looking at a changed screen in the integrated browser of the harness when it has one (browser checks were removed in bundle 1.19.0; the separate `flow-check` and `flow-verify` skills were removed in bundle 1.17.0 and are offered for removal from a tool that still has them). `flow-align` is the one a person types to bring a repo's rule files and their agent's memory in line with the flow rules: it changes only what is provably stale, contradicting, duplicated or a needless stop, backs every file up first, and never loosens a safety rule or deletes a memory. Installing and updating them is the skill `flow-update-skills`, which calls the `flow_skills` MCP tool; a tool with no skill installed yet reads it with `workflow_get` (name `flow-update-skills`), and the server instructions carry the one line that says so. It writes the newest version straight over the old one through a temporary folder, with no backup copy, and deletes obsolete skills and files that are no longer shipped.

`flow` also says when a plan is split (section 2 step 3a): work one agent does in order is one plan with phases, and a child plan (`item_new` or `item_update` with `parent`, one level only) is for a piece that ships or is reviewed on its own or runs in parallel. The board folds child plans into their master card and gives the master a Children tab.

The bundle has one semver release number and a changelog. Every skill has its own version and a SHA-256 hash.

## Getting them

Open **Connect a tool**, the **Skills** tab (`/connect?tab=skills`):

- **Copy install prompt** gives your agent everything it needs: where each tool keeps skills, how to check what is installed, and what to do when a skill was edited by hand. It asks before it overwrites anything.
- **Download bundle** gives a zip with every skill folder.

The agent reads `GET /api/v1/system-skills` (no sign in, no data of yours) for the release number, the per-skill versions and hashes and the changelog.

## Where the source lives

`src/lib/server/system-skills/` is the only place a skill is edited. `.claude/skills/` in this repository is regenerated from it and is never edited by hand. To release a change: edit there, bump the skill version and the bundle version, add a changelog line. A test fails when a skill changed without a version bump, and another fails when a skill names a path, port, project key or gate command of one repo outside a line marked `(example)`: the skills are generic, and a repo's own rules go in its CLAUDE.md or AGENTS.md.

## Installing through the MCP

A tool that has the board's MCP connected needs no copy and paste. The connection instructions tell its agent to offer the install once, when no flow skill is in its list, and `session_start` adds a `skillsNotice`: a plain hint to call `flow_skills` once when the agent passes no `skillsBundle`, and an offer or an update notice when it passes `skillsBundle` (the `afb-bundle` line of an installed skill, or `none`) and the skills are missing or older.

- `flow_skills` takes the harness, the scope (user or project) and what the agent found installed (per skill: the stamp version and hash, the hash it worked out for the file without its stamp lines, and whether a supporting file was edited). It answers with one action per skill: `install`, `update`, `unchanged`, or `ask` (edited by hand, not from this bundle, newer, or not checked). Whatever the agent did not report counts as `ask`, never as `update`. An unknown tool gets no folder.
- `skills_file` serves one file as installed, in parts of 12000 characters, each with the sha256 of the whole file. Use it only when the harness cannot fetch the public files or the zip.
- On one yes the agent installs everything the plan marks `install` or `update`, backs up any file before overwriting, checks every sha256 and asks only about a skill marked `ask`. The sha256 shows a file arrived whole; it does not prove who sent it, so the yes is the trust step.

`workflow_get` still serves the same texts, with the front matter removed, for a harness that cannot install files.
