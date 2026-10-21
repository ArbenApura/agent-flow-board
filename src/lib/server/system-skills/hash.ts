// PURE HELPERS FOR THE SYSTEM SKILLS (AFB-20261021-0401): LINE ENDINGS, HASHES, FRONT MATTER AND THE VERSION STAMP
// No Vite and no file access here, so the sync script (tsx), the loader and the tests all use the same functions.

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';

// -- TYPES -- //

export type SkillFile = { path: string; text: string };

// -- CONSTANTS -- //

/** The keys the bundle adds to a SKILL.md front matter. They are removed again before the source hash is worked out. */
export const STAMP_KEYS = ['afb-bundle', 'afb-version', 'afb-source-sha256'] as const;

// -- FUNCTIONS -- //

/** LF line endings and no byte order mark, so a hash is the same on every machine. */
export const normalize = (raw: string) =>
	(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, '\n');

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The served text of a SKILL.md: no YAML front matter, LF line endings, one trailing newline. */
export function stripFrontMatter(raw: string): string {
	const text = normalize(raw);
	if (!text.startsWith('---\n')) return `${text.trimEnd()}\n`;
	const end = text.indexOf('\n---', 3);
	if (end < 0) throw new Error('A SKILL.md front matter is not closed.');
	return `${text
		.slice(end + 4)
		.replace(/^\n+/, '')
		.trimEnd()}\n`;
}

/** The flat keys of a front matter. A block value (> or |) is folded into one line; nested keys are not read. */
export function frontMatterKeys(raw: string): Record<string, string> {
	const text = normalize(raw);
	if (!text.startsWith('---\n')) return {};
	const end = text.indexOf('\n---', 3);
	if (end < 0) throw new Error('A SKILL.md front matter is not closed.');
	const lines = text.slice(4, end).split('\n');
	const keys: Record<string, string> = {};
	for (let i = 0; i < lines.length; i++) {
		const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
		if (!m) continue;
		let value = m[2].trim();
		if (value === '>' || value === '|' || value === '>-' || value === '|-') {
			const parts: string[] = [];
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
			value = parts.join(' ');
		}
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
		keys[m[1]] = value;
	}
	return keys;
}

/** One hash for a whole skill: every file in path order, each as its path, a line break, its text and a line break. */
export function skillHash(files: SkillFile[]): string {
	const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
	return sha256Hex(ordered.map((f) => `${f.path}\n${normalize(f.text)}\n`).join(''));
}

/** A SKILL.md as it is installed: the bundle, the skill version and the hash of the unstamped source go in its front matter. */
export function stampSkill(source: string, bundle: string, version: string): string {
	const text = normalize(source);
	if (!text.startsWith('---\n'))
		throw new Error('A SKILL.md needs a front matter to carry a stamp.');
	const end = text.indexOf('\n---', 3);
	if (end < 0) throw new Error('A SKILL.md front matter is not closed.');
	const lines = [
		`afb-bundle: ${bundle}`,
		`afb-version: ${version}`,
		`afb-source-sha256: ${sha256Hex(text)}`
	];
	return `${text.slice(0, end)}\n${lines.join('\n')}${text.slice(end)}`;
}

/** The unstamped text of an installed SKILL.md: the three stamp lines removed. Its hash is the one the stamp records. */
export function unstampSkill(installed: string): string {
	return normalize(installed)
		.split('\n')
		.filter((line) => !STAMP_KEYS.some((k) => line.startsWith(`${k}:`)))
		.join('\n');
}
