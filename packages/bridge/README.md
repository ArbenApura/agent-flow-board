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

More check commands:

| Command                                                                                   | What it does                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-flow-board check project <NAME> --org <slug> --repo <dir> [--app-dir web]`         | Registers a repo folder (and an optional app folder) for a board project, or a live site with `--url`. A repo must be inside a folder the owner approved. |
| `agent-flow-board check approve --action <roots\|register\|secrets\|adopt-env\|pictures>` | The owner, on a terminal, gets a single-use code (10 minutes). Agents cannot make one.                                                                    |
| `agent-flow-board check roots add\|list\|remove`                                          | The owner-approved parent folders a registration may live in (at most 5).                                                                                 |
| `agent-flow-board check secrets import\|list\|forget`                                     | Seals test Supabase and mail values per registration (owner's code needed). Names only are ever printed.                                                  |
| `agent-flow-board check login <NAME> --org <slug> --seeded`                               | Saves a sign in for a registration from `AFB_CHECKS_<NAME>_EMAIL` and `_PASSWORD`.                                                                        |
| `agent-flow-board check service install\|status\|uninstall`                               | Windows: starts the worker when you sign in.                                                                                                              |
| `agent-flow-board check import-legacy --from <afb-checks folder> --org <slug>`            | Read only: re-registers the old tool's projects and copies its check scripts.                                                                             |

Runs share the machine: a slot set, one browser per host set, one database container with a clone per run, and kept dependencies and builds.

Check scripts and run state live in `~/.agent-flow-board/checks/`, never in a repo. Playwright is not installed with the bridge: the first run installs it there.

The sandboxed check can write its own run folder only. What the tool must be able to trust lives outside it: the live and end markers of a run (`checks/markers/`, checked against the names the tool derives for that run before any sweep acts on them) and the install, build, preview and mail-guard logs (`checks/logs/<run id>/`, which can hold values the app printed). Pictures and `result.json` are read from the run folder only when they are plain files (never a link), small enough, and the right kind of file. Changing the folder, the app folder, the site or the hosts of a registration that keeps an adopted `.env` or saved state needs the owner's `register` code (for a live site the code names `NAME@host`), and adopting a `.env` for another folder needs its own `adopt-env` code. A run started by hand stops after 40 minutes (`AFB_CHECKS_RUN_LIMIT_MS` changes it). Warm previews are not enabled in this version: `"warm": true` in a recipe is refused.

The easy way to set everything up is the **Editor status** tab on the board's **Connect a tool** page: copy its prompt into Claude Code and the agent does the steps, asking you once before it writes anything.

## What it writes

- Your sign in: in the operating system keychain (an encrypted file where there is none).
- `~/.agent-flow-board/status/<conversation id>.json`: what the board says a conversation works on. It holds no token and is removed when the conversation ends.
- `~/.agent-flow-board/backups/`: backups of settings files that `setup` changed.

## Licence

MIT. See `LICENSE`.
