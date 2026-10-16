# Importing a HAPR board

The importer reads a HAPR `.board` folder and writes it into this product as one organisation with one project. It **only reads** the board. It copies the three things it reads (`flow` without its `.git`, `attachments` and `TASKS.md`) into a temporary folder and imports from the copy, so a tool writing to the live board meanwhile cannot change what is compared. It lists every file it reads with a checksum before and after, and the report says whether the live board changed meanwhile. It refuses to put a report, a database or a storage folder inside the board.

## Run it

Sign up on the board first, so the owner of the new organisation exists. Then, from this repository:

```
yarn import:hapr --board C:/path/to/.board --owner you@example.com
```

| Option                                  | Meaning                                                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--board`                               | The `.board` folder (the one that holds `flow`)                                                                                                                                                     |
| `--owner`                               | The email of an existing user who becomes the owner of the organisation                                                                                                                             |
| `--org`, `--project`                    | The address and key of the new organisation and project. Default `hapr` and `HAPR`                                                                                                                  |
| `--db-dir`, `--storage-dir`, `--report` | Where the local PGlite database, the stored files and the report go (defaults under `.afb/`). With `DATABASE_URL` set the import goes into that PostgreSQL database and files go to `--storage-dir` |
| `--dry-run`                             | Read and count, write nothing                                                                                                                                                                       |
| `--create-owner`                        | Makes the owner when no such user exists. For a trial database only                                                                                                                                 |

Run it again and it skips every item that already has its FLOW id: a half finished import can simply be started again.

## What it makes

- Each HAPR item becomes an item numbered `HAPR-1` upward in id order. Every FLOW id and every legacy `FEAT-nnn` number answers to it.
- The plan becomes phases, steps and manual checks, keeping their states, and the frozen percent of a closed legacy item. Notes under a waived or superseded step become its reason.
- ADRs and the "Settled without asking" table become decisions. The six documents and any other Markdown file in the item folder are also kept whole as documents (`spec`, `plan` as written, `progress`, `validation`, `references`, one for each extra file), so nothing in an old format is lost. Text is stored with the byte order mark dropped and line breaks as LF.
- History, `LOG.md` lines and creation become activity events with their old dates. They carry the actor label "HAPR import" and cannot be undone.
- The "UI changes" tables become UI changes rows. Browser check results and UI shots results attached to an item become runs with their commits and, for shots, their pictures.
- Attachments keep their visibility, caption and references, and every other file in an item folder (scripts, data, pictures) is kept as a private file. A file whose checksum does not match its record is reported.
- Tasks keep their text, group, priority and links, and the status `FUTURE`.
- A row of `removed-items.json` with no folder becomes an item with the title the ID map gives it.
- The project is made a web app with the themes `hapr` and `gameplan`, and "Agents may set COMPLETED" is off, as HAPR keeps closing for Arben.

Not imported: the live claims of the running HAPR Board, and the registry history rows of `history-legacy.md` (they belong to the registry, not to an item; the report says how many).

## The report

The report compares every fact with the database **by content**, not by count: each item field, phase, step, manual check, ADR field, settled row, document (by checksum), event with its date, UI changes row, attachment record and the bytes stored for each file, run result and its pictures, and task. For every open item it also compares the percent with the one the old tools wrote into the generated block of `PROGRESS.md`. Any difference is listed with the item and what was expected. The command exits 0 only when there are none.

On the real HAPR board (116 items, 9 removed rows, 23 tasks, 256 attachments, 456 working files) the report compared 3,739 facts of 23 kinds with zero mismatches.

## Switching sessions to the new board

The import does not touch `.board` or the HAPR Board that runs on it. Moving the team's sessions onto this board (connecting their tools, turning the old board's hooks off) is a separate decision, made after the new board has been used for a while.
