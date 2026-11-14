// THE SYSTEM SKILLS: THE FLOW SKILLS THE PRODUCT SHIPS, ONE VERSIONED BUNDLE (AFB-20261021-0401)
// ./skills holds the sources (the only place they are edited), ./manifest.json the bundle version, each skill's version and
// hash and the changelog. They are read with import.meta.glob so they are inside the build, never from a folder at run time.
// Nothing here is per organisation or per person: the index, the files and the zip are the same for every caller.

// IMPORTED TYPES
import type { SkillFile } from './hash';
// IMPORTED MODULES
import manifestJson from './manifest.json';
import {
	frontMatterKeys,
	normalize,
	sha256Hex,
	skillHash,
	stampSkill,
	stripFrontMatter
} from './hash';
import { zipStored } from './zip';

// -- TYPES -- //

export type Manifest = {
	bundle: { version: string; releasedAt: string };
	skills: Record<string, { version: string; history: { version: string; hash: string }[] }>;
	changelog: { version: string; date: string; notes: string[]; skills: Record<string, string> }[];
};

export type SystemSkill = {
	name: string;
	version: string;
	description: string;
	/** The source hash recorded in the manifest and checked by the tests. */
	hash: string;
	/** The files as they are installed: the SKILL.md carries the version stamp. */
	files: (SkillFile & { sha256: string; bytes: number })[];
};

export type SystemSkillsIndex = {
	bundle: { version: string; releasedAt: string; sha256: string };
	skills: {
		name: string;
		version: string;
		description: string;
		hash: string;
		files: { path: string; sha256: string; bytes: number }[];
	}[];
	changelog: Manifest['changelog'];
};

// -- CONSTANTS -- //

export const MANIFEST = manifestJson as Manifest;

const SOURCES = import.meta.glob('./skills/**/*.md', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const SEMVER = /^\d+\.\d+\.\d+$/;

// -- FUNCTIONS -- //

/** The source files of every skill, grouped by folder. A file outside a skill folder is refused. */
export function sourceFiles(): Record<string, SkillFile[]> {
	const out: Record<string, SkillFile[]> = {};
	for (const [key, raw] of Object.entries(SOURCES)) {
		const m = /^\.\/skills\/([^/]+)\/(.+)$/.exec(key);
		if (!m) throw new Error(`A system skill file sits outside a skill folder: ${key}`);
		(out[m[1]] ??= []).push({ path: m[2], text: normalize(raw) });
	}
	for (const files of Object.values(out)) files.sort((a, b) => (a.path < b.path ? -1 : 1));
	return out;
}

let cached: SystemSkill[] | null = null;

/** Every skill in manifest order, as installed. Fails loudly when the manifest and the files disagree. */
export function systemSkills(): SystemSkill[] {
	if (cached) return cached;
	const sources = sourceFiles();
	const names = Object.keys(MANIFEST.skills);
	if (!names.length) throw new Error('The system skills manifest lists no skill.');
	if (!SEMVER.test(MANIFEST.bundle.version))
		throw new Error(`The bundle version is not semver: ${MANIFEST.bundle.version}`);
	for (const folder of Object.keys(sources))
		if (!MANIFEST.skills[folder])
			throw new Error(`The skill folder ${folder} is missing from the system skills manifest.`);
	cached = names.map((name) => {
		const entry = MANIFEST.skills[name];
		const files = sources[name];
		if (!files?.some((f) => f.path === 'SKILL.md'))
			throw new Error(`The system skill ${name} has no SKILL.md.`);
		if (!SEMVER.test(entry.version))
			throw new Error(`The version of ${name} is not semver: ${entry.version}`);
		const skillMd = files.find((f) => f.path === 'SKILL.md')!;
		const keys = frontMatterKeys(skillMd.text);
		const served = files.map((f) => {
			const text =
				f.path === 'SKILL.md' ? stampSkill(f.text, MANIFEST.bundle.version, entry.version) : f.text;
			return {
				path: f.path,
				text,
				sha256: sha256Hex(text),
				bytes: new TextEncoder().encode(text).length
			};
		});
		return {
			name,
			version: entry.version,
			description: keys.description ?? '',
			hash: skillHash(files),
			files: served
		};
	});
	return cached;
}

/** The served workflow text of a skill: its SKILL.md without the front matter. */
export function skillBody(name: string): string {
	const files = sourceFiles()[name];
	const md = files?.find((f) => f.path === 'SKILL.md');
	if (!md) throw new Error(`No system skill named ${name}.`);
	return stripFrontMatter(md.text);
}

/** A supporting file of a skill, as the workflow_get tool serves it. */
export function skillSupportText(name: string, path: string): string {
	const f = sourceFiles()[name]?.find((x) => x.path === path);
	if (!f) throw new Error(`No file ${path} in the system skill ${name}.`);
	return f.text.trimEnd() + '\n';
}

/** One file as it is installed, or null when the skill or the path is unknown. */
export function servedFile(name: string, path: string): string | null {
	return (
		systemSkills()
			.find((s) => s.name === name)
			?.files.find((f) => f.path === path)?.text ?? null
	);
}

/** One served file with its sha256 and byte length, or null when the skill or the path is unknown. */
export function servedSkillFile(name: string, path: string) {
	return (
		systemSkills()
			.find((s) => s.name === name)
			?.files.find((f) => f.path === path) ?? null
	);
}

/** A hash of the whole release, so a client and a cache can tell a new bundle from the same one. */
export function bundleSha256(): string {
	return sha256Hex(
		`${MANIFEST.bundle.version}\n${systemSkills()
			.flatMap((s) => s.files.map((f) => `${s.name}/${f.path} ${f.sha256}`))
			.join('\n')}`
	);
}

/** The document the Skills tab and an installing agent read. */
export function systemSkillsIndex(): SystemSkillsIndex {
	return {
		bundle: { ...MANIFEST.bundle, sha256: bundleSha256() },
		skills: systemSkills().map((s) => ({
			name: s.name,
			version: s.version,
			description: s.description,
			hash: s.hash,
			files: s.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }))
		})),
		changelog: MANIFEST.changelog
	};
}

let zip: Uint8Array | null = null;

/** The bundle as a zip, built once per process: one folder per skill, every file as it is installed. */
export function systemSkillsZip(): Uint8Array {
	if (zip) return zip;
	const encoder = new TextEncoder();
	zip = zipStored(
		systemSkills().flatMap((s) =>
			s.files.map((f) => ({ path: `${s.name}/${f.path}`, data: encoder.encode(f.text) }))
		)
	);
	return zip;
}
