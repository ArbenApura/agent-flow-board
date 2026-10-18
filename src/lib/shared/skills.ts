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
export const SKILL_SUMMARY_MAX = 300;
export const SKILL_BODY_MAX = 100_000;
/** An imported SKILL.md keeps room for its front matter above the body cap. */
export const SKILL_FILE_MAX = 120_000;
/** More than this in one project and the prompt list stops being useful (ADR SKILLS 5). */
export const MAX_SKILLS_PER_PROJECT = 50;

export const SKILL_NAME_HINT =
	'Lowercase letters, digits and dashes, for example release-notes. A built-in workflow name cannot be used.';

// -- TYPES -- //

export type SkillFile = { name: string; summary: string; body: string };

// -- FUNCTIONS -- //

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
const FLAT_KEY = /^[a-z][a-z0-9_-]*$/;

/**
 * Reads a SKILL.md: its front matter and its body. Only flat `name` and `description` keys are understood; a nested value,
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
	for (const line of head.split('\n')) {
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		const at = line.indexOf(':');
		if (at < 1) throw new Error(`This front matter line is not a key and a value: ${line.trim()}`);
		const key = line.slice(0, at).trim();
		const value = line
			.slice(at + 1)
			.trim()
			.replace(/^["']|["']$/g, '');
		if (!FLAT_KEY.test(key)) throw new Error(`"${key}" is not a plain front matter key.`);
		if (key !== 'name' && key !== 'description')
			throw new Error(`Only name and description are read from the front matter, not "${key}".`);
		if (value.startsWith('|') || value.startsWith('>'))
			throw new Error(`"${key}" must be one line. Use the body for longer text.`);
		if (ANCHOR.test(value))
			throw new Error(`Anchors and aliases are not read from front matter ("${key}").`);
		fields[key] = value;
	}
	if (!fields.name) throw new Error('The front matter needs a name.');
	if (body.length > SKILL_BODY_MAX)
		throw new Error(`The body is longer than ${SKILL_BODY_MAX} characters.`);
	return { name: fields.name, summary: fields.description ?? '', body: body.trimEnd() };
}
