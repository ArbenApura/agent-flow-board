// THE INSTALL PLANNER FOR THE SYSTEM SKILLS (AFB-20261021-0803): WHAT AN AGENT SHOULD DO FOR EACH SKILL IN ITS HARNESS
// Pure: it gets the served skills and what the agent found installed, and returns one action per skill. The server never reads
// a person's disk, so the agent reports its own findings and anything it did not report counts as "ask", never as "update".
// Every path in the answer is built from the manifest only, never from what the caller sent.

// -- TYPES -- //

export type Harness = (typeof HARNESSES)[number];
export type Scope = 'user' | 'project';
export type SkillAction = 'install' | 'update' | 'unchanged' | 'ask';

/** What an agent reports about one skill folder it found. Every field is the agent's own reading. */
export type InstalledSkill = {
	name: string;
	/** The afb-version line of the installed SKILL.md. */
	stampVersion?: string;
	/** The afb-source-sha256 line of the installed SKILL.md. */
	stampSha256?: string;
	/** The sha256 the agent worked out for the installed SKILL.md without its three stamp lines (LF endings, no byte order mark). */
	computedSha256?: string;
	/** True when the agent found a supporting file changed by hand, false when it checked and none was. */
	otherFilesChanged?: boolean;
	/** The sha256 of the supporting files as read, when the agent can hash them. */
	files?: { path: string; sha256: string }[];
};

/** The part of a served skill the planner needs. systemSkills() returns this shape. */
export type ServedSkill = {
	name: string;
	version: string;
	files: { path: string; sha256: string; bytes: number }[];
};

export type SkillPlan = {
	name: string;
	action: SkillAction;
	/** One plain sentence the agent can show the person. */
	reason: string;
	version: string;
	installedVersion: string | null;
	files: { path: string; sha256: string; bytes: number }[];
};

export type InstallPlan = {
	harness: Harness;
	scope: Scope;
	/** The skills folder, or null when the harness has no folder this server knows. */
	folder: string | null;
	skills: SkillPlan[];
	/** How many reported folders are not skills of this bundle. They are left alone and never named. */
	ignored: number;
};

// -- CONSTANTS -- //

/** What an agent does with the plan. It lived in a skill once; a tool reply reaches an agent that has no skill yet. */
export const INSTALL_STEPS = [
	'1. Offer once per session, and only when the person did not ask for the install: name this connection, the board address, the folder and the skills, then wait for a yes. After one yes do everything below without more questions.',
	'2. Find the harness (claude-code, gemini-cli, antigravity, codex or other) and the scope (user unless the person says project). When folder is null, read the tool documentation for its skills folder or ask the person.',
	'3. List the skills folder. For each folder named like a bundle skill, read its SKILL.md front matter and report stampVersion (afb-version), stampSha256 (afb-source-sha256) and computedSha256: the sha256 of the SKILL.md after removing the lines that start with afb-bundle:, afb-version: and afb-source-sha256:, with LF line endings and no byte order mark. Report otherFilesChanged and files when you can compare them.',
	'4. Call flow_skills with checked true and what you found. Act on each skill by its action: install and update write every listed file, unchanged does nothing, ask shows the person the reason (and what differs for an edited skill) and waits for a yes.',
	'5. Write one skill at a time. Get each file from the urls in this reply when you can fetch, otherwise from skills_file (pass next as the next offset and join the parts). Copy any file you overwrite to <name>.<timestamp>.bak first. Keep the file names and folder layout; flow-critic has supporting files next to its SKILL.md.',
	'6. Compare the sha256 of every file you wrote with the plan. If one differs, delete what you wrote for that skill, say so and go on. Never keep a file that failed the check.',
	'7. Tell the person, skill by skill: installed, updated (from which version to which), unchanged or skipped (and why). Quote the changelog lines. Some tools load new skills only in a new session.'
];

export const HARNESSES = ['claude-code', 'gemini-cli', 'antigravity', 'codex', 'other'] as const;

// The same table as the install brief (src/lib/connect/skillsBrief.ts). Codex and an unknown tool have no folder here.
const FOLDERS: Record<Harness, Record<Scope, string> | null> = {
	'claude-code': { user: '~/.claude/skills', project: '.claude/skills' },
	'gemini-cli': { user: '~/.gemini/skills', project: '.gemini/skills' },
	antigravity: { user: '~/.agents/skills', project: '.agents/skills' },
	codex: null,
	other: null
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const SKILL_FILE = 'SKILL.md';

// -- FUNCTIONS -- //

export const skillsFolder = (harness: Harness, scope: Scope): string | null =>
	FOLDERS[harness]?.[scope] ?? null;

/** Negative when a is older than b, zero when equal, positive when newer. NaN when either is not a plain semver. */
export function compareVersions(a: string, b: string): number {
	const x = SEMVER.exec(a);
	const y = SEMVER.exec(b);
	if (!x || !y) return Number.NaN;
	for (let i = 1; i <= 3; i++) {
		const d = Number(x[i]) - Number(y[i]);
		if (d !== 0) return d;
	}
	return 0;
}

function decide(
	served: ServedSkill,
	found: InstalledSkill | undefined,
	checked: boolean
): Pick<SkillPlan, 'action' | 'reason'> {
	// A skill nobody reported is only absent when the agent says it listed the folder and found nothing
	if (!found)
		return checked
			? { action: 'install', reason: 'Not installed yet.' }
			: {
					action: 'ask',
					reason:
						'Nothing was reported for it. List the skills folder and call again with checked true before installing.'
				};
	if (!found.stampVersion || !found.stampSha256)
		return {
			action: 'ask',
			reason: 'It has no bundle stamp, so it did not come from this bundle. Ask before touching it.'
		};
	const order = compareVersions(found.stampVersion, served.version);
	if (Number.isNaN(order))
		return { action: 'ask', reason: 'Its version is not one this bundle can compare.' };
	if (order > 0)
		return {
			action: 'ask',
			reason: `The installed version ${found.stampVersion} is newer than the served ${served.version}.`
		};
	if (!found.computedSha256)
		return {
			action: 'ask',
			reason: 'The installed SKILL.md was not hashed, so a hand edit cannot be ruled out.'
		};
	if (found.computedSha256 !== found.stampSha256)
		return { action: 'ask', reason: 'The installed SKILL.md was edited by hand.' };
	const support = served.files.filter((f) => f.path !== SKILL_FILE);
	if (found.otherFilesChanged === true)
		return { action: 'ask', reason: 'A supporting file was edited by hand.' };
	// Hashes of supporting files can be checked against the served text only for the same version
	const reported = new Map((found.files ?? []).map((f) => [f.path, f.sha256]));
	if (order === 0 && found.files?.length) {
		const edited = support.some((f) => reported.has(f.path) && reported.get(f.path) !== f.sha256);
		if (edited) return { action: 'ask', reason: 'A supporting file differs from the served one.' };
		const missing = support.some((f) => !reported.has(f.path));
		if (missing) return { action: 'update', reason: 'A supporting file is missing.' };
		return { action: 'unchanged', reason: `Already at ${served.version}.` };
	}
	// Without hashes the agent's own check is the only evidence, so an unreported check is a question
	if (support.length && found.otherFilesChanged !== false)
		return {
			action: 'ask',
			reason: 'The supporting files were not checked, so a hand edit cannot be ruled out.'
		};
	if (order === 0) return { action: 'unchanged', reason: `Already at ${served.version}.` };
	return { action: 'update', reason: `Older version ${found.stampVersion}, not edited.` };
}

/** The changelog entries an update crosses: those that moved a skill the plan updates past the version it has. */
export function changelogCrossed(
	changelog: { version: string; date: string; notes: string[]; skills: Record<string, string> }[],
	plan: InstallPlan,
	served: ServedSkill[]
): { version: string; date: string; notes: string[] }[] {
	const moving = plan.skills.filter((s) => s.action === 'update' && s.installedVersion);
	const target = new Map(served.map((s) => [s.name, s.version]));
	// An entry names every skill, so a skill counts as changed in an entry only when the next older entry has another version
	return changelog
		.filter((c, i) =>
			moving.some((s) => {
				const at = c.skills[s.name];
				const older = changelog[i + 1]?.skills[s.name];
				return (
					at &&
					at !== older &&
					compareVersions(at, s.installedVersion!) > 0 &&
					compareVersions(at, target.get(s.name) ?? at) <= 0
				);
			})
		)
		.map((c) => ({ version: c.version, date: c.date, notes: c.notes }));
}

/** One action per served skill, in served order. Reported folders that are not bundle skills are counted, never named. */
export function planSkills(
	served: ServedSkill[],
	harness: Harness,
	scope: Scope,
	installed: InstalledSkill[] = [],
	checked = false
): InstallPlan {
	const byName = new Map(installed.map((i) => [i.name, i]));
	const counts = new Map<string, number>();
	for (const i of installed) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
	const known = new Set(served.map((s) => s.name));
	return {
		harness,
		scope,
		folder: skillsFolder(harness, scope),
		skills: served.map((s) => {
			const found = byName.get(s.name);
			return {
				name: s.name,
				...((counts.get(s.name) ?? 0) > 1
					? {
							action: 'ask' as const,
							reason: 'It was reported twice with possibly different findings. Report it once.'
						}
					: decide(s, found, checked)),
				version: s.version,
				installedVersion:
					found?.stampVersion && SEMVER.test(found.stampVersion) ? found.stampVersion : null,
				files: s.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }))
			};
		}),
		ignored: new Set(installed.map((i) => i.name).filter((n) => !known.has(n))).size
	};
}

/**
 * The line session_start adds about the skills. The agent passes the afb-bundle value of an installed SKILL.md, or "none"
 * when it looked and found no flow skill. Left out, the server cannot tell "not installed" from "not sent", so it only hints.
 */
export function skillsNotice(passed: string | undefined, served: string): string | null {
	if (passed === 'none')
		return `The Agent Flow Board skills (bundle ${served}) are not installed in your tool. Offer the person to install them: call flow_skills.`;
	const order = passed === undefined ? Number.NaN : compareVersions(passed, served);
	if (passed === undefined || Number.isNaN(order))
		return 'If no flow skill is in your skill list, tell the person once, before you go on, that the Agent Flow Board skills (the /flow family) are not installed in this tool, and offer to install them: name this connection, its address and the folder flow_skills gives, and on one yes call flow_skills and install everything it plans. If your skill list has them, ignore this line.';
	return order < 0
		? `Your installed Agent Flow Board skills (bundle ${passed}) are older than the served ${served}. Call flow_skills and offer the update.`
		: null;
}

/**
 * One part of a text, cut on whole code points so the joined parts equal the text. Offsets are UTF-16 code units, as total is.
 * Throws a plain Error for an offset past the end or inside a surrogate pair (the tool turns it into INVALID).
 */
export function pageText(
	text: string,
	offset: number,
	part: number
): { text: string; next: number | null } {
	if (offset > 0 && offset >= text.length)
		throw new Error('The offset is past the end of the file.');
	const low = (i: number) => (text.charCodeAt(i) & 0xfc00) === 0xdc00;
	if (offset > 0 && low(offset)) throw new Error('The offset splits a character.');
	let end = Math.min(text.length, offset + part);
	if (end < text.length && low(end)) end -= 1;
	return { text: text.slice(offset, end), next: end < text.length ? end : null };
}
