# Publishing to GitHub

A project can keep a reference copy of its **public** items in a GitHub repository: Markdown and JSON files, one commit per publish, written through a GitHub App you own. Private items, private files and screenshots are never written. A publish is cancellable while it waits, and an unchanged project writes no commit.

Publishing is off until the server has the App's settings.

## 1. Register the App

Your server describes the App it needs at `https://<your domain>/github/manifest.json`. It asks for:

| Permission               | Why                                                            |
| ------------------------ | -------------------------------------------------------------- |
| Contents: read and write | Writes the copy                                                |
| Metadata: read           | Required by every App                                          |
| Pull requests: read      | Reads the commits of a pull request for the commit check       |
| Checks: write            | Shows a pass or a warning on a pull request that names no item |

and listens for `installation`, `installation_repositories`, `repository`, `push` and `pull_request`. The webhook address is `https://<your domain>/github/webhook`, and the setup and callback address is `https://<your domain>/github/callback`.

On github.com, under the account or organisation that should own it, go to Settings, Developer settings, GitHub Apps, New GitHub App. Fill in the same values, make the App private (installable only by its owner), and generate a webhook secret and a private key.

## 2. Give the server the App

Set these in `.env` and restart:

| Setting                  | Value                                                                     |
| ------------------------ | ------------------------------------------------------------------------- |
| `GITHUB_APP_ID`          | The numeric App ID                                                        |
| `GITHUB_APP_SLUG`        | The URL name, `github.com/apps/<slug>`                                    |
| `GITHUB_APP_PRIVATE_KEY` | The private key in PEM form. In an env file write the line breaks as `\n` |
| `GITHUB_WEBHOOK_SECRET`  | The webhook secret. Webhooks are refused while it is unset                |

## 3. Connect a project

Open the project, Publish, and connect a repository. The page sends you to GitHub to install the App on that repository and brings you back. The installation must be made from that link: an installation that already existed on GitHub before is refused, because nothing could show that your organisation owns it. Remove the App from the GitHub account and install it again from the project. Each folder of a repository belongs to one project, so two projects cannot publish into the same one. Then:

- **Publish now** writes the copy at once.
- **Automatic publish** writes it after a delay you choose (so a change can still be undone), only inside the days and hours you choose, and never twice at the same time. After three failures in a row it pauses itself and tells the project's Owners and Admins.
- A **public** repository is refused when the project has private items or private files, because the copy must not leak them. Make those items public, or use a private repository.

## What is in the copy

`README.md` (also `registry.md`) lists the public items with their status and progress. Each item has a folder `items/<ref>/` with `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`, `UI-CHANGES.md` when it has them, and `docs/<name>.md` for each document. `snapshot.json` holds the same data for tools. Pictures and every private item stay on the board.

## Commit links

A commit whose message has a trailer line such as `Item: CKT-12` (also `board-item:`, `items:`, `ref:`, `closes:` or `fixes:`) is linked to that item and shown on the item and the project Health page until someone records the work. A pull request that names no item gets a warning check, never a failure.
