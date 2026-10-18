# Skills: your own instructions, served to every agent

A skill is text your team writes once and every agent connected to the board obeys. It is served over MCP, so nothing has to be copied into a checkout, and it is kept under revision so a change is never lost.

Built by `AFB-20261018-0622`.

## The four places a skill can come from

An agent that reads a name sees exactly one skill. The order is:

1. **Built-in.** The five workflows the board ships (`flow`, `flow-task`, `flow-interview`, `flow-critic`, `flow-audit`). They cannot be renamed, removed or shadowed; a custom skill may not take their names.
2. **Organisation.** Written by an owner or an admin, read by every project in the organisation.
3. **Project.** Written by a member of that project and read by it.
4. **A file in the checkout**, at `.claude/skills/<name>/SKILL.md`. When it exists it wins, and every read says so.

Where the same name exists at the organisation and the project level, the organisation one is the one an agent reads. Both are listed, so nobody wonders where their text went.

## Reading them as an agent

- **`skill_get`** reads one skill by name: any level, with its level, author, revision, content hash and a trust header. Pass the project key so the project's skills and its organisation's are reachable. A long skill comes in pages: pass the returned `next` as `offset` **and the same `revision`**. If the skill changed in between, the call answers `stale-revision` instead of handing you a second half from another version.
- **Prompts.** Every skill is registered as an MCP prompt, so it appears in a tool's prompt list: `<projectkey>-<name>` for a project skill and `org-<name>` for an organisation one. The prefix means a custom prompt can never collide with a built-in or with another project.
- **`project_rules`** lists the name, the summary and the prompt name of every skill a project reads, capped at 50, with a pointer to `skill_get` when there are more. The text itself is never in that reply.

Access: reading needs the read right on the project and no claim on an item. A guest never sees a skill. A token limited to some projects sees only those projects' skills (the organisation's are still readable).

## Writing them

- **Project skills:** the project's **Skills** page, under More in the sidebar.
- **Organisation skills:** Organisation settings, the **Skills** section. Owners and admins write; everyone else reads.
- **A SKILL.md:** the editor takes a file or pasted text. Only flat `name` and `description` keys in the front matter are read; an anchor, an alias, a block value or another key is refused rather than guessed at. The description becomes the summary.
- **Limits:** a name is a lowercase slug (letters, digits, single dashes), the summary is at most 300 characters, the body at most 100,000. A project holds at most 50 skills, the most a prompt list can carry.
- **Revisions:** every save keeps the text it replaced, with its author, its hash and its number. Deleting a skill keeps them and frees the name.
- **No secrets.** A skill is an instruction every agent follows, so a password, API key or token put there is given away. Both editors say so.

Every skill read returns a SHA-256 hash over its name, summary and body; a built-in hashes the text the board serves. The same hash is used by the bridge below.

## Files in a checkout (the bridge)

An agent that prefers files, and a person reading the repository, can get the board's skills written down:

```
agent-flow-board skills --server https://board.example.com --project AFB [--dir <repo>] [--check] [--force]
```

It reads the same REST routes the browser does and writes three files per skill:

| Tool        | Path                             |
| ----------- | -------------------------------- |
| Claude Code | `.claude/skills/<name>/SKILL.md` |
| Antigravity | `.agents/skills/<name>/SKILL.md` |
| Gemini CLI  | `.gemini/skills/<name>/SKILL.md` |

`.afb/skills.json` records, for each skill, the board's hash and the hash of every file written. On the next run:

- a file that still matches its recorded hash is replaced when the board's text changed;
- a file somebody edited by hand is reported as **drift** and left alone, until `--force` replaces it;
- the files of a skill the board no longer has are removed, unless they were edited by hand.

`--check` writes nothing and exits 1 when a file is out of date, so a CI step can ask whether the checkout is current.

**Codex gap.** Codex has no skill file adapter yet: it reads no `.codex/` skill directory and the bridge writes nothing for it. On Codex, an agent uses the `skill_get` tool and the registered prompts instead, which every harness gets. When a Codex skill format exists, it becomes a fourth target in `packages/bridge/src/skills/materialize.ts`.
