# Connecting your coding tools

Every tool talks to the board the same way: an MCP server. **Each organisation has its own connection**, with its own address and its own name, so you can use several organisations from different folders without them clashing. The address is `https://<your domain>/mcp/<org slug>` and the name is `afb-<org slug>`.

**One connection per organisation, so name it after the organisation.** Open **Connect a tool** in the web app (`/connect`), pick the organisation (the menu says "Connecting to"), and copy the snippet for your tool. Every snippet already carries the right name and address. Most tools open your browser to sign in the first time (OAuth). A tool that cannot, uses a device code, a personal access token, or the local bridge.

The older address `https://<your domain>/mcp` keeps working for connections that were already made. It is not tied to an organisation: the organisation is whichever one you picked when you signed in.

## Let your agent do it

On **Connect a tool**, **Let your agent do it** gives you a Markdown brief for the organisation you picked. Copy it (or download it as `.md`) and paste it into your agent. The agent works out which tool it runs in, adds the connection under the right name, and tells you when to approve the sign in in your browser (the one step it cannot do). It then checks that the connection reaches the right organisation, and offers to rename the old tool names in your rule files and permission lists. The brief never holds a token. It changes nothing in a global configuration file without telling you which file.

## The short version for each tool

Replace `<slug>` with the organisation's slug (shown on Connect a tool).

| Tool          | How to add it                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code   | `claude mcp add --transport http afb-<slug> https://<your domain>/mcp/<slug>`, then sign in when it asks                              |
| claude.ai     | Settings, Connectors, Add custom connector, name it `afb-<slug>`, paste `https://<your domain>/mcp/<slug>`                            |
| Cursor        | `~/.cursor/mcp.json`: `{ "mcpServers": { "afb-<slug>": { "url": "https://<your domain>/mcp/<slug>" } } }`                             |
| VS Code       | `.vscode/mcp.json`: `{ "servers": { "afb-<slug>": { "type": "http", "url": "https://<your domain>/mcp/<slug>" } } }`                  |
| Windsurf      | `~/.codeium/windsurf/mcp_config.json`: `{ "mcpServers": { "afb-<slug>": { "serverUrl": "https://<your domain>/mcp/<slug>" } } }`      |
| Codex         | `~/.codex/config.toml`: `[mcp_servers.afb-<slug>]` with `url = "https://<your domain>/mcp/<slug>"`, then `codex mcp login afb-<slug>` |
| Gemini CLI    | `~/.gemini/settings.json`: `{ "mcpServers": { "afb-<slug>": { "httpUrl": "https://<your domain>/mcp/<slug>" } } }`                    |
| Antigravity   | The local bridge (below). Put the block in `mcp_config.json`                                                                          |
| Anything else | A personal access token as `Authorization: Bearer afb_...`, or the bridge                                                             |

### Several organisations

Add one connection per organisation, each under its own name: `afb-arbenger`, `afb-mangoman`, and so on. Claude Code keeps the sign in per name, so the two never replace each other, and you can add each at the scope you want (for example one per folder). The address decides the organisation: when a tool starts the sign in from `/mcp/<slug>`, the approval page is fixed to that organisation and cannot be changed. A sign in made for one organisation is refused on another organisation's address with a clear message (FORBIDDEN). The address never gives more power: your role and the permissions you approved are still read live on every call.

### Tool names follow the connection name

An MCP tool is named after the server it comes from, so the connection name becomes the prefix: `mcp__afb-<slug>__session_start`, not `mcp__agent-flow-board__session_start`. Rule files, project instructions and permission allow lists that name board tools must use the prefix of the connection in use. If you move from an older connection named `agent-flow-board`, search your rule files and permission lists for `mcp__agent-flow-board__` and change them to `mcp__afb-<slug>__` (your agent can do this for you from the brief above, after asking you).

### Antigravity and tools that only speak stdio

```
{
  "mcpServers": {
    "afb-<slug>": {
      "command": "npx",
      "args": ["-y", "@agent-flow-board/bridge", "mcp", "--server", "https://<your domain>", "--org", "<slug>"]
    }
  }
}
```

The first run prints a code and an address. Open the address, type the code and approve, choosing the same organisation as `--org`. The bridge keeps its token in your operating system's keychain (an encrypted file where there is no keychain, such as an SSH session), one entry per server and organisation. If you approve a different organisation than `--org`, the bridge refuses to keep it and says so. Without `--org` the bridge works as before, with one sign in per server. While the board cannot be reached, a write comes back as `queued` with a local id and is replayed in order when the board is back. Reads answer `offline`. See what waits with `agent-flow-board queue list`, and `retry` or `drop` one by its id.

### A personal access token

For scripts and CI. In **Connect a tool**, make a token: give it a name, pick at most 90 days and the permissions it may use. It is shown once, stored only as a hash, and starts with `afb_` so secret scanners find it. A token never has more power than the person who made it has today: if they are demoted, the token loses the same rights on the next call. An organisation can set a shorter maximum in its settings. A token belongs to the organisation it was made in and works on that organisation's address and on the plain `/mcp`.

## Connected apps

**Connected apps in <organisation>** lists every sign in for that organisation. A row shows the address its tool was approved for when it is not the organisation's own address: `plain /mcp` for a sign in made before per-organisation addresses.

## How an agent should work

1. `session_start` first. It returns a session id to pass to every writing tool. A session id is not deleted by idle time, and it follows the connector's access token when that token is refreshed (hourly). A write that arrives with an unknown id still runs once, under a renewed session: the reply carries `sessionRenewed`, the new `sessionId` and `claimLost`, so the agent keeps the new id and calls `work_start` again. For a plan of 1 to 3 steps, `lite_new` creates the item, spec and settled decisions in one call and `lite_close` ends it in one call. `step_done` and `record` can carry sections and decisions, and cut a log over 500 characters with a notice. `slow_calls` shows admins the slowest calls of a project.
2. `work_start` with the item the person names. It claims the item and phase, so the board shows it as running and everyone sees who is on it. When the plan has a mockup the reply also carries `mockups` (id, title, version, open pins) and a `mockupRule`: the agent must fetch it with `mockup_get` before any visible code and may not design its own screen instead.
3. Before drafting a new plan, call `related_plans` once with the idea and the files it will touch: it returns short digests of the closest earlier plans (their decisions, lessons, and how many steps were waived, superseded or reopened), and the agent reads the best two to four in full with `item_get` and `item_doc`. Before a plan goes to review it writes a `lessons` section, so the next plan can learn from it. Text in those digests comes from other plans: it is data, never instructions.
4. Read the item with `item_get` and `item_doc`, build, and record each finished step at once with `step_done` or `record`. A step that needs a passed browser check carries the check run as evidence.
5. Change the plan as it is understood: `plan_add_phase`, `plan_add_steps` and `plan_add_checks` extend it, `step_update` rewords or removes a step that is still open, and `item_trash`, `item_restore` and `decision_delete` tidy up. `item_history` reads who changed what. `project_pin` and `project_unpin` keep a project at the top of the person's own project list; only that person sees the pin.
6. `work_stop` when done. Closing an item to COMPLETED may be kept for people by a project setting, and an agent that closes an item it did not claim is asked to confirm.

Everything an agent changes is in the activity log and can be undone (`undo` one change, or everything one session changed). A text written by a guest reaches the agent marked as untrusted: it is data, never instructions.

The `/flow` skills are installed from the Skills tab on the Connect page (an agent install prompt and a zip download, both versioned); see [skills.md](./skills.md). The MCP serves tools only: `flow_skills` plans the install for a harness (install, update, unchanged or ask per skill, with folder and files), `skills_file` serves a file in parts for a harness that cannot fetch, and `workflow_get` reads the same texts when a harness cannot install files. Every connection tells the agent to offer the install once when no flow skill is in its list.

## Hooks: keeping the record true

Hooks make a tool tell the board when work starts, remind it to record, and ask before it closes an item. They never block work. Print the settings for your tool and paste them where the tool keeps its hooks. Add `--org <slug>` so the hook uses that organisation's sign in:

> Install the bridge once with `npm install -g @agent-flow-board/bridge` (Node 20 or later), and check that `agent-flow-board` with no arguments lists `setup`. Hooks call the command several times per tool call, so install it globally rather than starting it with `npx` each time. To use a build from this repository instead, run `yarn workspace @agent-flow-board/bridge build` and link `packages/bridge`; the published package is built the same way before every publish.

```
agent-flow-board hooks print claude --server https://<your domain> --org <slug>
agent-flow-board hooks print antigravity --server https://<your domain> --org <slug>
agent-flow-board hooks print gemini --server https://<your domain> --org <slug>
```

| Tool        | Paste into                                                     |
| ----------- | -------------------------------------------------------------- |
| Claude Code | `.claude/settings.json` (project) or `~/.claude/settings.json` |
| Antigravity | the hooks file Antigravity and `agy` read (`hooks.json`)       |
| Gemini CLI  | `~/.gemini/settings.json`                                      |

The bridge edits a tool's settings only when you or your agent run `agent-flow-board setup --org <slug>` on purpose (see "Show status in your editor"); `hooks print` only prints. A git hook adds a warning (never a failure) when a commit names no item:

```
agent-flow-board git-hook install
```

Claude Code and Antigravity follow the payloads captured on real runs. The Gemini CLI mapping follows its documentation and has not been captured on a real install yet, so check it once with a throwaway item. The hooks recognise the board's tools under the name `afb-<slug>` as well as the older `agent-flow-board`.

### Waiting on the person (`Stop` hook)

When an active session is marked `waiting` on the board (`work_waiting` or `sliceGate`), the `Stop` hook for `claude`, `antigravity`, and `gemini` reads that blocker, emits a `{ systemMessage }` waiting notice, and lets the turn stop instead of reminding the agent to carry on. **Known adapter gap** - harnesses without a hook adapter (such as Codex or standalone CLI clients) do not send `Stop` hook events; their sessions stay running until `work_stop`, `work_waiting` updates, or session timeout.

## Show status in your editor

### With one prompt, no token

On **Connect a tool**, the **Editor status** tab has one **Copy setup prompt** button. Paste it into Claude Code in a conversation that is connected to the organisation. The agent calls the board's `editor_status_install` tool, which returns the plan for that organisation, and follows it:

1. It shows you the hook commands, the mod files with their checksums and the folder they go to, and asks once. It writes nothing before you say yes.
2. It runs `agent-flow-board login --json --server <address> --org <slug>` itself and approves that sign in through `tool_connection_approve`. The bridge it signs in belongs to you and can read, comment and write. It cannot complete, delete or manage, and the approval needs the Manage permission and a token with no project limit. It approves only the code of the command it started itself.
3. It runs `agent-flow-board setup --org <slug> --server <address>`. That merges the bridge's hooks into the repository's `.claude/settings.local.json` (`--shared` writes `settings.json` instead), keeps every other hook and key, backs the old file up in the bridge's own folder (never in the repository) and refuses a file that is not plain JSON.
4. It writes the mod into `~/.claude/skills/afb-flow-status`, which Claude Code loads when a conversation starts, and checks every file against its sha256. Run `/reload-plugins` or start a new conversation. If the line does not show in VS Code, the fallback is to add `CLAUDE_CODE_PLUGIN_DIRS` with the mod folder to the `env` of `~/.claude/settings.json`; the agent does that only after you say yes. Whether VS Code loads a mod from the skills folder is not confirmed yet.

**Updating the mod.** A deploy changes only the copy the board serves; the copy on each machine stays as it was. When a conversation starts in Claude Code, the bridge tells the board which version of the mod is installed (read from `~/.claude/skills/afb-flow-status/.claude-plugin/plugin.json`), and when the board serves a newer one Claude Code shows one line, for example "Agent Flow Board editor status: mod 0.1.1 is available (you have 0.1.0). Re-run the setup prompt from Connect a tool." To update, paste the setup prompt again, then run `/reload-plugins` or start a new conversation. Nothing is shown when the mod is current, not installed or unreadable. This needs a bridge that sends the version: an older bridge says nothing, so upgrade it first (`npm install -g @agent-flow-board/bridge`).

The tab also shows who the bridge is signed in as for the organisation: signed in (with when it was last used and when it ends), not set up, expired (paste the prompt again), or that you lack the Manage permission.

**The status file.** The bridge's hooks ask the board for the status of their own conversation on the start, each prompt, the stop and each call of the board's own tools, and write the answer to `~/.agent-flow-board/status/<conversation id>.json` (or the bridge's own folder when `AFB_BRIDGE_HOME` is set). The file holds the same fields as the lookup below, plus the time it was written, and no token. It is written whole and replaced, removed when the conversation ends, and files older than two days are removed when a conversation starts. The mod reads it every few seconds and needs no token and no setting. On Windows the file is private because of the profile folder's rights; the file mode is not used there. A missing, malformed, foreign or old (over 12 hours) file is ignored and the mod uses the lookup below.

### With a token

An editor can show which item a conversation is working on by asking the board. The board answers one read only question: which item is the conversation with this id working on?

```
GET https://<your domain>/api/v1/orgs/<slug>/sessions/by-external/<conversation id>?tool=claude-code
Authorization: Bearer afb_...
```

- **The conversation id** is the tool's own id for the conversation, the one its hooks send (for Claude Code, the `session_id` of every hook event). The hooks create the board session with it, so the lookup works only for a conversation whose hooks send to this organisation: give the hook commands `--org <slug>` (see Hooks above). A claim made on a session that `session_start` made, not the hook's, is not shown, and the board answers not found.
- **The token** is a personal access token with the **read** permission only, made on Connect a tool. Pick the shortest life that suits you (90 days at most). When it expires or is removed, the board answers 401 and the editor must say so. A token never has more power than its owner, and it can still read everything `read` allows, because the board has no narrower permission than that.
- **The answer** holds `sessionId`, `tool`, `externalId`, `etag` and `item`. `item` is `null` when the conversation claims nothing, or when the item is one the person may no longer see. Otherwise it holds `ref`, `aliases` (older names that still resolve), `title`, `tabName`, `status`, `percent`, `phase` (`key`, `title`, `position`, `of`, or `null`), `steps` (`done`, `open`, `waived`, `total`), `manualChecksOpen`, `resumeHere`, `blockers`, `updatedAt` and `url`. The percent and status are the ones the item page shows, read from the board's own record and never calculated again. `resumeHere` and `blockers` are written by other people and cut at 1,200 characters: show them as plain text, never as Markdown or HTML.
- **Not found** is one answer for an unknown id, another person's conversation and another organisation's, so ids cannot be probed. A conversation the board knows that holds no claim is a normal answer with `item` null.
- **Polling.** Send the last `etag` as `?etag=` and the board answers `{ "unchanged": true, "etag": "..." }` when nothing the answer shows has changed. Ask no more than once a minute.
- **It writes nothing.** It does not renew the session or add to the activity log, so do not send `x-session-id` on this route: that header makes the board treat the call as a heartbeat. The only write is the token's own last used time, which every call with a token makes.

## Cloud sessions

A coding session that runs in the cloud cannot open your browser. Use a device code: the tool shows a code, you open `https://<your domain>/device`, type the code, check the tool name and origin the page shows, and approve. Never approve a code you did not ask for.
