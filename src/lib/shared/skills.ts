// THE RULES EVERY CUSTOM SKILL OBEYS, SHARED BY THE FORM, THE ZOD SCHEMAS, THE OPERATIONS VERBS AND THE MCP TOOL
// A skill is text every agent obeys, so its name, its size and what an imported SKILL.md may carry are fixed here once.

// -- CONSTANTS -- //

/** Lowercase letters, digits and single dashes. The same shape a Claude skill folder takes. */
export const SKILL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The five workflows the board serves itself. A custom skill may not take one of these names (ADR SKILLS 1). */
export const BUILTIN_SKILL_NAMES = [
	'flow',
	'flow-task',
	'flow-interview',
	'flow-critic',
	'flow-audit'
] as const;

export const SKILL_NAME_MAX = 64;
export const SKILL_SUMMARY_MAX = 4000;
export const SKILL_BODY_MAX = 100_000;
/** An imported SKILL.md keeps room for its front matter above the body cap. */
export const SKILL_FILE_MAX = 120_000;
/** More than this in one project and the prompt list stops being useful (ADR SKILLS 5). */
export const MAX_SKILLS_PER_PROJECT = 50;
/** Supporting files: how many a skill holds, how long one may be, and the most its body and files hold together. */
export const SKILL_FILES_MAX = 20;
export const SKILL_FILE_BODY_MAX = 100_000;
export const SKILL_TOTAL_MAX = 300_000;
export const SKILL_FILE_PATH_MAX = 120;

export const SKILL_NAME_HINT =
	'Lowercase letters, digits and dashes, for example release-notes. A built-in workflow name cannot be used.';

// -- TYPES -- //

export type SkillFile = { name: string; summary: string; body: string };

/** A supporting Markdown file of a skill: a path inside the skill folder and its text. */
export type SkillSupportFile = { path: string; body: string };

// -- FUNCTIONS -- //

/** Windows device names, which cannot be a file name on that system even with an extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Why a supporting file path is refused, or null when it is fine. A path is written into a checkout by the bridge, so it must
 * stay inside the skill folder: relative, forward slashes, no `.` or `..` segment, no drive letter, only Markdown.
 */
export function skillFilePathError(path: string): string | null {
	if (path.length === 0 || path.length > SKILL_FILE_PATH_MAX)
		return `A file path is 1 to ${SKILL_FILE_PATH_MAX} characters.`;
	// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
	if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(path))
		return `"${path}" holds a character a file path cannot carry (a backslash, a colon or a control character).`;
	if (path.startsWith('/')) return `"${path}" must be relative, without a leading slash.`;
	const segments = path.split('/');
	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..')
			return `"${path}" must not hold an empty, "." or ".." part.`;
		if (segment.endsWith('.') || segment.endsWith(' '))
			return `"${path}" has a part that ends in a dot or a space.`;
		if (RESERVED_NAMES.test(segment.split('.')[0]))
			return `"${path}" uses a name Windows reserves.`;
	}
	if (!path.toLowerCase().endsWith('.md'))
		return `"${path}" must be a Markdown file ending in .md.`;
	if (path.toLowerCase() === 'skill.md')
		return 'SKILL.md is the skill itself, not a supporting file.';
	return null;
}

/**
 * Why a skill's body and supporting files are refused, or null when they fit: the count, each path, a path used twice, each
 * file's length, and the most the body and every file hold together. One function, so the form, the verbs and the bridge tell
 * the same story.
 */
export function skillFilesError(body: string, files: SkillSupportFile[]): string | null {
	if (files.length > SKILL_FILES_MAX)
		return `A skill holds at most ${SKILL_FILES_MAX} supporting files.`;
	const seen = new Set<string>();
	let total = body.length;
	for (const file of files) {
		const bad = skillFilePathError(file.path);
		if (bad) return bad;
		const key = file.path.toLowerCase();
		if (seen.has(key)) return `"${file.path}" is listed twice.`;
		seen.add(key);
		if (file.body.length === 0) return `"${file.path}" is empty.`;
		if (file.body.length > SKILL_FILE_BODY_MAX)
			return `"${file.path}" is longer than ${SKILL_FILE_BODY_MAX} characters.`;
		total += file.body.length;
	}
	if (total > SKILL_TOTAL_MAX)
		return `The body and the files hold ${total} characters, more than the ${SKILL_TOTAL_MAX} a skill may carry.`;
	return null;
}

/** The files in path order, the order they are stored, compared and hashed in. */
export function sortSkillFiles(files: SkillSupportFile[]): SkillSupportFile[] {
	return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The text a skill's hash is taken over. A skill without files hashes exactly as before this existed, so no stored hash or
 * bridge manifest changes; each file then adds its path and body, two line breaks apart, in path order.
 */
export function skillHashText(
	skill: { name: string; summary: string; body: string },
	files: SkillSupportFile[] = []
): string {
	let text = `${skill.name}\n\n${skill.summary}\n\n${skill.body}`;
	for (const file of sortSkillFiles(files)) text += `\n\n${file.path}\n\n${file.body}`;
	return text;
}

/** True when the name may be used at all: the right shape and not one of the five built-ins. */
export function isSkillName(name: string): boolean {
	return SKILL_NAME.test(name) && name.length <= SKILL_NAME_MAX && !isBuiltinSkillName(name);
}

export function isBuiltinSkillName(name: string): boolean {
	return (BUILTIN_SKILL_NAMES as readonly string[]).includes(name);
}

/** The prompt name a custom skill is registered under, so it can never collide with a built-in or another project. */
export const promptNameFor = (projectKey: string, name: string) =>
	`${projectKey.toLowerCase()}-${name}`;

/** A title or a file name as a slug, for the name field of the editor. */
export function skillNameFrom(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, SKILL_NAME_MAX);
}

const ANCHOR = /^[&*]/;
const BLOCK_VALUE = /^[|>][+-]?\d?$/;
const FLAT_KEY = /^[a-z][a-z0-9_-]*$/;

/**
 * Reads a SKILL.md: its front matter and its body. Only flat `name` and `description` keys are understood (a block value is folded into one line); a nested value,
 * an anchor or an alias is refused instead of guessed at, because a skill that silently loses a line is worse than one that
 * does not import (ADR SKILLS 3).
 */
export function parseSkillFile(text: string): SkillFile {
	const file = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
	if (file.length > SKILL_FILE_MAX)
		throw new Error(`That file is longer than ${SKILL_FILE_MAX} characters.`);
	if (!file.startsWith('---\n'))
		throw new Error(
			'A SKILL.md starts with front matter: a line of ---, then name and description, then ---.'
		);
	const end = file.indexOf('\n---', 3);
	if (end < 0)
		throw new Error('The front matter of this SKILL.md is not closed with a line of ---.');
	const head = file.slice(4, end);
	const body = file.slice(end + 4).replace(/^\n+/, '');
	const fields: Record<string, string> = {};
	const lines = head.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		const at = line.indexOf(':');
		if (at < 1) throw new Error(`This front matter line is not a key and a value: ${line.trim()}`);
		const key = line.slice(0, at).trim();
		let value = line
			.slice(at + 1)
			.trim()
			.replace(/^["']|["']$/g, '');
		if (!FLAT_KEY.test(key)) throw new Error(`"${key}" is not a plain front matter key.`);
		if (/^\s/.test(line)) throw new Error(`"${key}" is nested. Front matter keys are flat.`);
		// A block value (| or >, with an optional - or +) is the indented lines under it. A summary is one line, so they are
		// joined with single spaces; the same is done for a key that is skipped, so its lines are never mistaken for keys
		if (BLOCK_VALUE.test(value)) {
			const block: string[] = [];
			while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s/.test(lines[i + 1])))
				block.push(lines[++i].trim());
			value = block.filter(Boolean).join(' ');
			if (key === 'name' || key === 'description') {
				if (!value) throw new Error(`"${key}" is empty.`);
				fields[key] = value;
			}
			continue;
		}
		// Other flat keys (disable-model-invocation, allowed-tools) belong to the harness that wrote the file and are skipped.
		if (key !== 'name' && key !== 'description') continue;
		if (ANCHOR.test(value))
			throw new Error(`Anchors and aliases are not read from front matter ("${key}").`);
		fields[key] = value;
	}
	if (!fields.name) throw new Error('The front matter needs a name.');
	if (body.length > SKILL_BODY_MAX)
		throw new Error(`The body is longer than ${SKILL_BODY_MAX} characters.`);
	return { name: fields.name, summary: fields.description ?? '', body: body.trimEnd() };
}

/** A file a person picked: the name it came with (a relative path when a folder was picked) and its text. */
export type SkillPick = { name: string; text: string };

export type SkillPickResult = {
	/** The SKILL.md among the picks, parsed, or null. */
	skill: SkillFile | null;
	/** The other picks that can be supporting files. */
	files: SkillSupportFile[];
	/** One plain sentence for everything that was left out or went wrong. */
	problems: string[];
};

/**
 * Reads what a person picked in the file dialog: one SKILL.md and any number of supporting Markdown files. A folder pick
 * names its files with the folder in front, which is dropped when every pick shares it. Each pick that cannot be used is
 * named in `problems` and left out, so nothing is dropped silently and the rest still comes through.
 */
export function readSkillPicks(
	picks: SkillPick[],
	options: { needSkill: boolean }
): SkillPickResult {
	const named = picks.map((p) => ({
		path: p.name.replaceAll('\\', '/').replace(/^\.\//, ''),
		text: p.text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
	}));
	// One shared top folder is the skill's own folder, so its name is not part of a file path
	const tops = new Set(named.map((n) => n.path.split('/')[0]));
	if (named.length > 0 && named.every((n) => n.path.includes('/')) && tops.size === 1)
		for (const n of named) n.path = n.path.slice(n.path.indexOf('/') + 1);
	const problems: string[] = [];
	const skills = named.filter((n) => n.path.toLowerCase() === 'skill.md');
	const rest = named.filter((n) => n.path.toLowerCase() !== 'skill.md');
	let skill: SkillFile | null = null;
	if (skills.length > 1) problems.push('More than one SKILL.md was picked. Pick one.');
	else if (skills.length === 1) {
		if (options.needSkill) {
			try {
				skill = parseSkillFile(skills[0].text);
			} catch (e) {
				problems.push(e instanceof Error ? e.message : 'That SKILL.md was not read.');
			}
		} else problems.push('SKILL.md is the skill itself, so it was left out of the files.');
	} else if (options.needSkill) problems.push('Pick the SKILL.md as well, it names the skill.');
	const files: SkillSupportFile[] = [];
	const seen = new Set<string>();
	for (const n of rest) {
		const bad = skillFilePathError(n.path);
		if (bad) {
			problems.push(`${bad} It was left out.`);
			continue;
		}
		if (seen.has(n.path.toLowerCase())) {
			problems.push(`"${n.path}" was picked twice. The second one was left out.`);
			continue;
		}
		seen.add(n.path.toLowerCase());
		if (n.text.trim() === '') {
			problems.push(`"${n.path}" is empty, so it was left out.`);
			continue;
		}
		files.push({ path: n.path, body: n.text });
	}
	return { skill, files: sortSkillFiles(files), problems };
}
