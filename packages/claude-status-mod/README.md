# afb-flow-status

A Claude Code mod that shows which Agent Flow Board item a conversation is working on: the plan's short tab name, the reference (a link), the title, the phase, the percent and the status. It reads the board's read only lookup (see "Show status in your editor" in `docs/connect-tools.md`) and draws one line.

## Where it shows

- **Terminal and desktop app:** a band above the prompt.
- **VS Code:** this build does not raise the band above the prompt there, so the line goes in a pane, or in a row in the transcript when no pane is drawn. Type `/afb-status` to open the pane (a pane you ask for is placed at any width; one opened unasked needs a wide window). Whether VS Code draws it is to be checked by hand.

## Set it up

1. Make a token on **Connect a tool** with the **read** permission only (90 days at most).
2. Load the mod from this folder: `claude --plugin-dir packages/claude-status-mod`.
3. In the mod settings, fill in the board address, your organisation name (the slug in the board address) and the token.
4. The hooks of your repo must send to the same organisation: give each hook command `--org <slug>`.

The token is kept as a sensitive setting and is never written in this folder, drawn in the band or put in an error message.

## What the line says

| State                           | Line                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| Working on an item              | tab name, reference, title, phase, percent, status                   |
| The board is slow or away       | the same, marked with how old the answer is                          |
| No item claimed                 | No item claimed in this conversation.                                |
| Not found (HTTP 404)            | a message naming the likely causes: organisation name, or hooks' org |
| Token expired, removed, no read | a message to make a new read token                                   |
| A setting is missing            | a message to fill in the settings                                    |

It asks about once a minute, backs off while the board fails, and asks at once after one of the board's own tools (`work_start`, `step_done`, `item_status`, `work_stop`) ran.

## Develop

```
claude plugin validate packages/claude-status-mod
claude plugin test packages/claude-status-mod
```
