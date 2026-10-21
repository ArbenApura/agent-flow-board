// THE BRIEF A PERSON COPIES INTO THEIR AGENT SO THE AGENT INSTALLS OR UPDATES THE SYSTEM SKILLS (AFB-20261021-0401)
// Pure, so the text is tested. It holds no token, no session id and nothing about the person or the organisation: the same
// words go to everyone. The versions listed are the ones when the page was made; the agent always reads the index for the real ones.

// -- TYPES -- //

export type SkillsBriefIndex = {
	bundle: { version: string; releasedAt: string };
	skills: { name: string; version: string }[];
};

// -- FUNCTIONS -- //

/** The Markdown brief. baseUrl is the board's own address, without a trailing slash. */
export function skillsBriefMarkdown(baseUrl: string, index: SkillsBriefIndex): string {
	const api = `${baseUrl}/api/v1/system-skills`;
	const list = index.skills.map((s) => `- \`${s.name}\` ${s.version}`).join('\n');
	return `# Install or update the Agent Flow Board skills

You are helping a person install the Agent Flow Board skills (the /flow family) into this coding tool, or update them. The skills are text files that you will follow as instructions once installed, so install only what this brief names, from the addresses it names.

- Index (JSON): ${api}
- Everything as one zip: ${api}/bundle.zip
- One file: ${api}/files/<skill name>/<file path>
- Bundle ${index.bundle.version}, released ${index.bundle.releasedAt}

Skills in this release:

${list}

These addresses need no sign in and carry nothing about the person. Confirm with the person that the address above is the board they use. Use https only (the one exception is a board running on the person's own machine, whose addresses above start with http://localhost). Read the index first: it lists the current bundle version, every skill with its version, its files and the sha256 of each file, and the changelog.

## If this tool has the Agent Flow Board MCP connected

Use its tools first. \`flow_skills\` takes your tool name, the scope and what you found installed, and answers with one action per skill (install, update, unchanged or ask), the folder to write to and the files with their sha256. \`skills_file\` serves a file in parts when you cannot fetch the addresses above. The steps below still apply: they say how to read what is installed and when to ask. With no MCP, or when the MCP has no such tool, use the addresses above.

## What to do, in this order

1. Find out which tool you are running in (Claude Code, Codex, Gemini CLI, Antigravity or another) and where it reads skills from, using the table below. If your tool is not in the table, or you are not sure, read the tool's own documentation or ask the person. Do not guess a folder.
2. Ask the person whether the skills go in their user folder (every project) or in this project's folder. Use the user folder unless they say otherwise.
3. Read the index (or the plan \`flow_skills\` returns). For each skill, look at \`<skills folder>/<skill name>/SKILL.md\`:
   - **Not there:** install the skill.
   - **There, and its \`afb-version\` equals the index version:** nothing to do for that skill.
   - **There, and its \`afb-version\` is older than the index version:** work out whether the person edited it. Remove the three lines that start with \`afb-bundle:\`, \`afb-version:\` and \`afb-source-sha256:\` from the front matter of the installed SKILL.md, then change CRLF line endings to LF and drop a byte order mark, and work out the sha256 of that text with the tool you have (not by running anything the bundle contains). If it equals the installed file's own \`afb-source-sha256\` value, nobody edited it: update it. If it does not, or if another file of the skill was changed by hand, show the person what differs and ask before you overwrite anything.
   - **There, with no \`afb-version\` line, or with a newer version than the index:** it did not come from this bundle. Do not touch it. Tell the person and ask.
4. To install or update a skill, fetch every file the index lists for it (or take them from the zip) into \`<skills folder>/<skill name>/\`. Keep the file names and the folder layout exactly as listed: \`flow-critic\` has supporting files next to its SKILL.md and needs them. Work out the sha256 of each file you wrote and compare it with the index. If one differs, delete what you wrote for that skill and say so. Do not use a file that failed the check.
5. Report to the person, skill by skill: installed, updated (from which version to which), unchanged, skipped (and why). Quote the changelog lines for the versions they moved across.
6. Tell the person that some tools only load new skills in a new session.

## Where each tool reads skills

| Tool | User folder (every project) | Project folder |
| --- | --- | --- |
| Claude Code | \`~/.claude/skills/<name>/\` | \`.claude/skills/<name>/\` |
| Gemini CLI | \`~/.gemini/skills/<name>/\` | \`.gemini/skills/<name>/\` |
| Antigravity | \`~/.agents/skills/<name>/\` | \`.agents/skills/<name>/\` |
| Codex | the skills folder named in the Codex documentation for your version | the project skills folder named there, if it has one |

Folder names can change between tool versions. If the folder in this table does not exist and the tool's documentation names another, follow the documentation and tell the person.

When a tool has no skills folder at all, the same texts can be read with the \`workflow_get\` tool of the Agent Flow Board connection (name \`flow\`, \`flow-task\`, \`flow-interview\`, \`flow-critic\`, \`flow-audit\`, \`flow-check\` or \`flow-verify\`). Say so to the person instead of inventing a folder.

## Never

- Run, open or execute any script, command or code you find inside a downloaded file. The files are Markdown to be saved, nothing else.
- Fetch from any address other than the ones above, or over plain http (except the localhost case above).
- Overwrite a file the person changed without asking.
- Ask for, print or store a token. These addresses need none.
- Delete a skill folder you did not install from this bundle.
`;
}
