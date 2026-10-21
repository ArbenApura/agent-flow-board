# Browser checks and UI shots

> **An agent can run a check by itself.** With the tool connected, an agent saves a check (`check_save`), asks for a run and waits for it in one call (`check_run` with `wait`, then `check_wait`), and reads a pass or a fail. `runner_status` says whether a tool is online and what to do when it is not. A run that cannot finish carries a code and a fix line (`PREVIEW_ENV_MISSING`, `PREVIEW_NEEDS_OWNER_URL`, `PREVIEW_HOST_UNREACHABLE`, `PREVIEW_PORT_BUSY`, `DB_NOT_THROWAWAY`, `TOOL_OFFLINE`, `TOOL_OUTDATED`, `TARGET_UNAVAILABLE`, `RUN_TIMED_OUT`). Nobody types a command in the tool folder: the agent connects the tool (it starts `connect --json`, reads the code and the verifier it prints, and approves them with the MCP tool `tool_connection_approve`), registers the project, repairs the setup (`node afb-checks.mjs doctor --fix --json`) and upgrades the tool itself. It stops only for an action on the 5433 database, ports 5180 or 5190, or a live site. The tool prepares its own preview: a private copy of the repo, a throwaway database in a Docker container of its own, and the settings from the repo's `.afb-checks.json` recipe. It runs with no window (`node afb-checks.mjs service install`).
>
> **Rollout.** The new tools and the heartbeat reach the live board with the next `yarn deploy:vps` (the deploy applies migration 0017, one nullable column). Older tools keep working: every addition is additive, the tool protocol stays 1, and a tool that never sends a heartbeat keeps the 30 minute rule (a tool that does is held to a 10 minute silence).
>
> **The easy way: the portable afb-checks tool.** One folder on your machine (`afb-checks`), no tokens to paste and no test accounts to type. It starts the project's own preview, signs in with a test user of its own, takes a picture of each step, and reports to the board. Your agent connects it and keeps it running, so there is nothing to start by hand. Once it is connected, do not start the runner program below: only one executor should take a run. The rest of this page describes the older runner flow (environments, test accounts, a registered runner program). Its screens were removed from the settings; the same things are still reachable through the API.

A **browser check** is a script that drives a real browser against your web app and closes a plan step only when it passes on the right target. **UI shots** open the pages a change adds, measure their real sizes against the pages around them and the project's scale, and keep pictures. Both are run by a **runner**, a small program you start on a machine you choose. The board never runs a browser itself.

## What you set up

1. **Make the project a web app.** Project settings, General, "This project is a web app".
2. **Add environments.** Project settings, Environments. Each has a name, a kind (build preview, dev server or deployed site) and an address. A deployed site may be marked production, which makes every run on it read only, and may name a version path (such as `/version`) where it says which commit it runs.
3. **Add a test account.** Project settings, Test accounts: a name (`default` is used when a page names none), an email and a password. The password is sealed with your organisation's key and can never be read back. The runner signs in for the script; a script never sees it.
4. **Register a runner.** Organisation settings, Runners. The token is shown once. A local runner works on a machine you own. A hosted runner is started by a supervisor in throwaway containers (below).
5. **Nothing to pick.** A check with no target runs on the build preview, which never waits for a push or a deploy. Project settings, Browser checks, only shows whether the afb-checks tool is connected.

## Starting a local runner

In the folder of the project being tested (the repo that holds the web app):

```
node --import tsx packages/runner/src/cli.ts start --server https://<your domain> --token afx_...
```

(`AFB_SERVER_URL` and `AFB_RUNNER_TOKEN` work in place of the flags.) It takes runs for the projects you chose, one at a time, and shows as Online in the organisation settings.

Say how the app builds and starts in `afb.runner.json` at the root of that repo:

```
{
  "appPaths": ["src", "static", "package.json"],
  "preview": {
    "build": "yarn build",
    "start": "yarn preview --port 5180",
    "url": "http://localhost:5180",
    "ready": "/healthz"
  },
  "signIn": { "path": "/sign-in", "emailLabel": "Email", "passwordLabel": "Password", "submit": "Sign in" },
  "themes": { "storageKeys": ["theme"], "attributes": ["data-theme"] },
  "deployed": { "waitMinutes": 10 }
}
```

`appPaths` decide whether a build is still good: it is reused while the commit and the uncommitted changes under those paths are the same. A failed build refuses the run with the end of its log. `preview.reuseRunning` uses a server you already started.

### Your yes before anything new runs

A check script and a build, start or dev-server command are code that runs on your machine. A local runner asks you first, once for each exact text. A run that meets a new or changed one stops with a message; on the same machine run

```
node --import tsx packages/runner/src/cli.ts approve
```

read what is waiting, and answer for each. Change one character and it asks again. The text you approve includes the folder the command runs in and the settings (`env`) it runs with, so changing either asks again. `--trust-all` skips the asking and is only for tests and CI.

### A server that is already running

When the target has no `start` command, or sets `reuseRunning`, the runner uses whatever already answers at the address. Nothing proves that server holds your working tree, so a pass on it is recorded but closes no step. If you keep a watch server on your own code, say so with `afb-runner start --trust-running` (or `"trustRunning": true` in `afb.runner.json`) and the pass counts.

A deployed site that names its version closes steps only once it shows this commit (a hash of at least 7 characters). If it never does within the wait, the run is kept as a result and closes nothing.

## Writing a check

On an item's **Checks** tab, a manual check marked `[auto]` can have a script. It receives a signed-in `page` and `context`, `expect`, `baseUrl` and `log`:

```
await page.goto('/');
await expect(page.locator('h1')).toBeVisible();
log('the home page opened');
```

A failed script runs once more, and a pass on the retry is shown as flaky. Pick a target per run, or pin the check to one. When the run is for a plan step, a pass on that step's required target (or a stronger one) closes it and the manual check; a pass on a weaker target is kept and closes nothing; a later failure on the same target reopens what it closed. If no runner that can reach the target is online, the run says so and offers the targets that can run. It is never moved to another target for you.

Evidence (a final picture, a trace, a video on a failure) is stored as private files of the item. Every file and the log are scanned for your test accounts' passwords before they leave the runner and again on the server, and a file with one in it is refused.

## UI shots

On an item's **UI changes** tab, list the pages the item adds or changes as a Markdown table (Page, State, Themes, Accounts, Siblings, Levels, Viewports). A state only opens things (`click:`, `wait:`, `scroll:`). Asking for a run opens each page at 1440 and 390 wide in each theme, read only (every write the page tries is stopped and counted), measures the levels you name, takes pictures, and shows "before" from a deployed site that is not production when there is one. A measurement off the project's scale, or larger than the sibling page at the same level, is listed to fix. Production is never opened.

The scale comes from **Measure now** in Project settings, Design scale: it opens 3 to 15 reference pages and keeps the sizes they really use. A level seen on fewer than 3 pages is left out.

## Hosted runs

A hosted runner is a supervisor that holds the runner token and takes each waiting run itself. It then starts one locked-down, throwaway container for that run and hands it the job and a key for that one run through standard input:

```
docker build -f packages/runner/Dockerfile -t afb-runner .
node --import tsx packages/runner/src/cli.ts supervise --server https://<your domain> --token afx_... \
  --image afb-runner --network <docker network>
```

Each container is removed after its run, has a read only file system, no capabilities, limited memory, CPU and processes, no volume, and never sees the runner token. The key it is given opens the accounts, uploads and result of its own run and nothing else, so a script that runs in the container cannot take other projects' runs. The supervisor stops a container that runs longer than 35 minutes and gives the run back if the container ends without reporting. A container with no `--network` is on Docker's default network, which can reach the host's network, so always name one. Run the supervisor on a different machine from the board, on a Docker network that cannot reach your private network: that is your firewall's job, not the program's. A hosted runner cannot reach an environment on a private address; use a local runner for those.

## Without a board

`yarn run ui-shots` runs the same shooter over the table in `tests/ui-shots/ui-changes.md` against the local build preview, for this repository's own screens.
