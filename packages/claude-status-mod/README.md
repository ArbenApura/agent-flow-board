# afb-flow-status

A Claude Code mod that shows which Agent Flow Board item a conversation is working on: the plan's short tab name, the reference (a link), the title, the phase, the percent and the status. It reads the board's read only lookup (see "Show status in your editor" in `docs/connect-tools.md`) and draws one line.

## Where it shows

- **Terminal and desktop app:** a band above the prompt, only while an item is claimed.
- **VS Code:** the same band above the prompt. Type `/afb-status` to open the pane too: it has the whole title, and a Details button for Resume here, Blockers and the step counts.

## Set it up

**The easy way, no token.** On **Connect a tool**, open **Editor status** and copy the setup prompt into Claude Code. The agent signs the bridge in, writes the hooks of your repo and puts this mod in `~/.claude/skills/afb-flow-status`. The bridge's hooks then write each conversation's status to `~/.agent-flow-board/status/<conversation id>.json` and the mod reads that file. It needs no setting and no token. A missing, malformed, foreign or old (over 12 hours) file is ignored and the mod uses the way below. See "Show status in your editor" in `docs/connect-tools.md`.

**By hand, with a token.**

1. Make a token on **Connect a tool** with the **read** permission only (90 days at most).
2. Load the mod from this folder: `claude --plugin-dir packages/claude-status-mod`.
3. In the mod settings, fill in the board address, your organisation name (the slug in the board address) and the token.
4. The hooks of your repo must send to the same organisation: give each hook command `--org <slug>`.

The token is kept as a sensitive setting and is never written in this folder, drawn in the band or put in an error message. The status file holds no token.

## What the line says

| State                           | Line                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| Working on an item              | tab name, reference, title, phase, percent, status                   |
| The board is slow or away       | the same, marked with how old the answer is                          |
| No item claimed                 | No item claimed in this conversation.                                |
| Not found (HTTP 404)            | a message naming the likely causes: organisation name, or hooks' org |
| Token expired, removed, no read | a message to make a new read token                                   |
| A setting is missing            | a message to fill in the settings                                    |

It looks at the status file every few seconds. Without a file it asks the board about once a minute, backs off while the board fails, and asks at once after one of the board's own tools (`work_start`, `step_done`, `item_status`, `work_stop`) ran.

## Develop

```
claude plugin validate packages/claude-status-mod
claude plugin test packages/claude-status-mod
```
