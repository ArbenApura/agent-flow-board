# @agent-flow-board/bridge

The local bridge to an [Agent Flow Board](https://afb.arbenger.com) server. It forwards the board's MCP over stdio, runs the hooks of your coding tool (Claude Code, Antigravity, Gemini CLI) so the board stays true, and writes the status file that the editor status line reads. It holds no board tool code: every MCP tool lives on the server. It also runs browser checks on this machine (see Browser checks below).

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

### Browser checks

| Command                                                                             | What it does                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-flow-board check connect --server <url> --org <slug> --json`                 | Makes this machine a check runner of the organisation. An agent approves the printed code with the board's MCP. Only the runner token is kept.                                               |
| `agent-flow-board check run <item> <key> --server <url> --org <slug> [--step 1.2]`  | Asks for the run, claims that run only, builds a private copy of the repo in the current folder, previews it, runs the check in a sandbox and reports. Exit 0 pass, 1 fail, 2 could not run. |
| `agent-flow-board check pull <item> <key> --server <url> --org <slug>`              | Shows the board's copy of a check script as data. `--accept-hash <sha256>` writes exactly that text.                                                                                         |
| `agent-flow-board check watch [--parallel N] [--once]`                              | Takes runs started from the board's Run button, for folders where `check run` was used before.                                                                                               |
| `agent-flow-board check status`, `check doctor --fix`, `check clear`, `check setup` | Reads and repairs the state, removes old runs, installs the browser. All take `--json`.                                                                                                      |

Check scripts and run state live in `~/.agent-flow-board/checks/`, never in a repo. Playwright is not installed with the bridge: the first run installs it there.

The easy way to set everything up is the **Editor status** tab on the board's **Connect a tool** page: copy its prompt into Claude Code and the agent does the steps, asking you once before it writes anything.

## What it writes

- Your sign in: in the operating system keychain (an encrypted file where there is none).
- `~/.agent-flow-board/status/<conversation id>.json`: what the board says a conversation works on. It holds no token and is removed when the conversation ends.
- `~/.agent-flow-board/backups/`: backups of settings files that `setup` changed.

## Licence

MIT. See `LICENSE`.
