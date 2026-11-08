# @agent-flow-board/bridge

The local bridge to an [Agent Flow Board](https://afb.arbenger.com) server. It forwards the board's MCP over stdio, runs the hooks of your coding tool (Claude Code, Antigravity, Gemini CLI) so the board stays true, and writes the status file that the editor status line reads. It holds no tool code: every tool lives on the server.

## Install

```
npm install -g @agent-flow-board/bridge
agent-flow-board
```

Needs Node 20 or later. Run it with no arguments to see its usage; the list should include `setup`. Install it globally: the hooks call the command several times per tool call, and a command started through `npx` each time is too slow.

## Commands

| Command                                                           | What it does                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-flow-board login --server <url> --org <slug>`              | Signs in with a device code. The sign in is kept in your keychain, one entry per server and organisation.                                                                                                  |
| `agent-flow-board login --json --server <url> --org <slug>`       | For an agent: line 1 holds the code and a verifier, so the agent can approve it through the board's MCP. It never prints a token.                                                                          |
| `agent-flow-board setup --org <slug> --server <url>`              | Writes the Claude Code hooks into this repository's `.claude/settings.local.json` (`--shared` writes `settings.json`). It merges, keeps your other hooks and backs the old file up outside the repository. |
| `agent-flow-board hooks print claude --server <url> --org <slug>` | Prints the hook settings to paste by hand.                                                                                                                                                                 |
| `agent-flow-board mcp --server <url> --org <slug>`                | Forwards MCP over stdio, for tools that only speak stdio.                                                                                                                                                  |
| `agent-flow-board queue list`                                     | Shows writes held while the board could not be reached.                                                                                                                                                    |

The easy way to set everything up is the **Editor status** tab on the board's **Connect a tool** page: copy its prompt into Claude Code and the agent does the steps, asking you once before it writes anything.

## What it writes

- Your sign in: in the operating system keychain (an encrypted file where there is none).
- `~/.agent-flow-board/status/<conversation id>.json`: what the board says a conversation works on. It holds no token and is removed when the conversation ends.
- `~/.agent-flow-board/backups/`: backups of settings files that `setup` changed.

## Licence

MIT. See `LICENSE`.
