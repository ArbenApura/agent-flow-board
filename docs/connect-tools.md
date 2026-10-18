# Connecting your coding tools

Every tool talks to the board the same way: an MCP server at `https://<your domain>/mcp`. Open **Connect a tool** in the web app (`/connect`) for a ready-made snippet for each tool with your address filled in. Most tools open your browser to sign in the first time (OAuth). A tool that cannot, uses a device code, a personal access token, or the local bridge.

## The short version for each tool

| Tool          | How to add it                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code   | `claude mcp add --transport http agent-flow-board https://<your domain>/mcp`, then sign in when it asks                         |
| claude.ai     | Settings, Connectors, Add custom connector, paste `https://<your domain>/mcp`                                                   |
| Cursor        | `~/.cursor/mcp.json`: `{ "mcpServers": { "agent-flow-board": { "url": "https://<your domain>/mcp" } } }`                        |
| VS Code       | `.vscode/mcp.json`: `{ "servers": { "agent-flow-board": { "type": "http", "url": "https://<your domain>/mcp" } } }`             |
| Windsurf      | `~/.codeium/windsurf/mcp_config.json`: `{ "mcpServers": { "agent-flow-board": { "serverUrl": "https://<your domain>/mcp" } } }` |
| Codex         | `~/.codex/config.toml`: `[mcp_servers.agent-flow-board]` with `url = "https://<your domain>/mcp"`, then `codex mcp login`       |
| Gemini CLI    | `~/.gemini/settings.json`: `{ "mcpServers": { "agent-flow-board": { "httpUrl": "https://<your domain>/mcp" } } }`               |
| Antigravity   | The local bridge (below). Put the block in `mcp_config.json`                                                                    |
| Anything else | A personal access token as `Authorization: Bearer afb_...`, or the bridge                                                       |

### Antigravity and tools that only speak stdio

```
{
  "mcpServers": {
    "agent-flow-board": {
      "command": "npx",
      "args": ["-y", "@agent-flow-board/bridge", "mcp", "--server", "https://<your domain>"]
    }
  }
}
```

The first run prints a code and an address. Open the address, type the code and approve. The bridge keeps its token in your operating system's keychain (an encrypted file where there is no keychain, such as an SSH session). While the board cannot be reached, a write comes back as `queued` with a local id and is replayed in order when the board is back. Reads answer `offline`. See what waits with `agent-flow-board queue list`, and `retry` or `drop` one by its id.

### A personal access token

For scripts and CI. In **Connect a tool**, make a token: give it a name, pick at most 90 days and the permissions it may use. It is shown once, stored only as a hash, and starts with `afb_` so secret scanners find it. A token never has more power than the person who made it has today: if they are demoted, the token loses the same rights on the next call. An organisation can set a shorter maximum in its settings.

## How an agent should work

1. `session_start` first. It returns a session id to pass to every writing tool.
2. `work_start` with the item the person names. It claims the item and phase, so the board shows it as running and everyone sees who is on it.
3. Read the item with `item_get` and `item_doc`, build, and record each finished step at once with `step_done` or `record`. A step that needs a passed browser check carries the check run as evidence.
4. Change the plan as it is understood: `plan_add_phase`, `plan_add_steps` and `plan_add_checks` extend it, `step_update` rewords or removes a step that is still open, and `item_trash`, `item_restore` and `decision_delete` tidy up. `item_history` reads who changed what. `project_pin` and `project_unpin` keep a project at the top of the person's own project list; only that person sees the pin.
5. `work_stop` when done. Closing an item to COMPLETED may be kept for people by a project setting, and an agent that closes an item it did not claim is asked to confirm.

Everything an agent changes is in the activity log and can be undone (`undo` one change, or everything one session changed). A text written by a guest reaches the agent marked as untrusted: it is data, never instructions.

Your team's own skills are read with `skill_get` and appear as MCP prompts. To write them into a checkout for the tools that read files, run `agent-flow-board skills --project <KEY>`; see [skills.md](./skills.md).

## Hooks: keeping the record true

Hooks make a tool tell the board when work starts, remind it to record, and ask before it closes an item. They never block work. Print the settings for your tool and paste them where the tool keeps its hooks:

> The bridge package is not on npm yet. Until it is, build it from this repository (`yarn workspace @agent-flow-board/bridge build`) and run `node packages/bridge/dist/cli.js` in place of `npx -y @agent-flow-board/bridge`.

```
npx -y @agent-flow-board/bridge hooks print claude --server https://<your domain>
npx -y @agent-flow-board/bridge hooks print antigravity --server https://<your domain>
npx -y @agent-flow-board/bridge hooks print gemini --server https://<your domain>
```

| Tool        | Paste into                                                     |
| ----------- | -------------------------------------------------------------- |
| Claude Code | `.claude/settings.json` (project) or `~/.claude/settings.json` |
| Antigravity | the hooks file Antigravity and `agy` read (`hooks.json`)       |
| Gemini CLI  | `~/.gemini/settings.json`                                      |

The bridge never edits a tool's settings by itself. A git hook adds a warning (never a failure) when a commit names no item:

```
npx -y @agent-flow-board/bridge git-hook install
```

Claude Code and Antigravity follow the payloads captured on real runs. The Gemini CLI mapping follows its documentation and has not been captured on a real install yet, so check it once with a throwaway item.

## Cloud sessions

A coding session that runs in the cloud cannot open your browser. Use a device code: the tool shows a code, you open `https://<your domain>/device`, type the code, check the tool name and origin the page shows, and approve. Never approve a code you did not ask for.
