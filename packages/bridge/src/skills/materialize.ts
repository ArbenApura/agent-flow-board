// THE SKILL FILES THE BRIDGE WRITES FOR EACH TOOL (AFB-20261018-0622, ADR 6)
// The board is the source of truth; a checkout gets plain files so a tool that reads the disk (and a person reading the repo)
// sees the same skills. Every file is hashed, and a file somebody edited by hand is reported as drift and left alone.

// -- TYPES -- //
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';

// -- TYPES -- //

export type Target = 'claude' | 'antigravity' | 'gemini';

export type RemoteSkill = { name: string; summary: string; body: string; hash: string };

export type ManifestSkill = {
	/** The hash the board returns for the skill, so a person can compare it with a read. */
	hash: string;
	/** Each file the bridge wrote, and the hash of the bytes it wrote there. */
	files: Record<string, string>;
};
export type Manifest = { version: 1; skills: Record<string, ManifestSkill> };

export type FileAction = {
	target: Target;
	/** Relative to the checkout root, with forward slashes. */
	path: string;
	action: 'create' | 'update' | 'unchanged' | 'drift' | 'remove';
	text?: string;
};

export type Plan = { files: FileAction[]; manifest: Manifest };

export type PlanOptions = {
	/** Overwrite a file somebody changed by hand. Without it the file is reported and kept. */
	force?: boolean;
};

// -- CONSTANTS -- //

/** Where each tool reads a skill file. Gemini reads .gemini, Antigravity the .agents mirror this repo already keeps. */
export const TARGETS: Record<Target, (name: string) => string> = {
	claude: (name) => `.claude/skills/${name}/SKILL.md`,
	antigravity: (name) => `.agents/skills/${name}/SKILL.md`,
	gemini: (name) => `.gemini/skills/${name}/SKILL.md`
};

export const TARGET_NAMES = Object.keys(TARGETS) as Target[];

/** The manifest the bridge owns, so it never deletes a file it did not write. */
export const MANIFEST_PATH = '.afb/skills.json';

export const EMPTY_MANIFEST: Manifest = { version: 1, skills: {} };

// -- FUNCTIONS -- //

/** A SKILL.md: flat front matter with the name and the summary, then the body exactly as the board holds it. */
export function skillFileText(skill: { name: string; summary: string; body: string }): string {
	const oneLine = skill.summary.replace(/\s+/g, ' ').trim();
	return `---\nname: ${skill.name}\ndescription: ${oneLine}\n---\n\n${skill.body.replace(/\r\n/g, '\n').trimEnd()}\n`;
}

/** The same hash the board uses, so a manifest written here matches the `hash` a read returns. */
export function contentHash(text: string): string {
	// The bridge cannot import the server's helper, so it repeats SHA-256 over the same bytes
	return createHash('sha256').update(text).digest('hex');
}

/** The hash of a skill as the board computes it: name, summary and body, two line breaks apart. */
export function skillHashOf(skill: { name: string; summary: string; body: string }): string {
	return contentHash(`${skill.name}\n\n${skill.summary}\n\n${skill.body}`);
}

/**
 * What to write, keep or remove. A file is ours when the manifest records it and its bytes still hash to what was written;
 * a file somebody edited since is drift, reported and left alone unless `force` is set.
 */
export function planSkills(
	skills: RemoteSkill[],
	manifest: Manifest,
	read: (path: string) => string | null,
	options: PlanOptions = {}
): Plan {
	const files: FileAction[] = [];
	const next: Manifest = { version: 1, skills: {} };
	const live = new Map(skills.map((s) => [s.name, s]));
	for (const skill of skills) {
		const before = manifest.skills[skill.name];
		const written: Record<string, string> = {};
		let drifted = false;
		for (const target of TARGET_NAMES) {
			const path = TARGETS[target](skill.name);
			const text = skillFileText(skill);
			const existing = read(path);
			if (existing === null) {
				files.push({ target, path, action: 'create', text });
				written[path] = contentHash(text);
				continue;
			}
			if (existing === text) {
				files.push({ target, path, action: 'unchanged' });
				written[path] = contentHash(text);
				continue;
			}
			// Ours to overwrite when the manifest recorded these exact bytes at this path
			const ours = before?.files[path] === contentHash(existing);
			if (ours || options.force) {
				files.push({ target, path, action: 'update', text });
				written[path] = contentHash(text);
			} else {
				files.push({ target, path, action: 'drift' });
				drifted = true;
			}
		}
		// A drifted file keeps its old record, so the next run still sees a hand edit rather than treating it as new; the
		// files that were written on this run keep their fresh hashes, so they are not reported as hand edits later
		next.skills[skill.name] = drifted
			? {
					hash: before?.hash ?? skill.hash,
					files: { ...(before?.files ?? {}), ...written }
				}
			: { hash: skill.hash, files: written };
	}
	for (const [name, recorded] of Object.entries(manifest.skills)) {
		if (live.has(name)) continue;
		let kept = false;
		for (const [path, hash] of Object.entries(recorded.files)) {
			const existing = read(path);
			if (existing === null) continue;
			if (contentHash(existing) === hash) {
				const target = TARGET_NAMES.find((t) => TARGETS[t](name) === path) ?? 'claude';
				files.push({ target, path, action: 'remove' });
			} else {
				const target = TARGET_NAMES.find((t) => TARGETS[t](name) === path) ?? 'claude';
				files.push({ target, path, action: 'drift' });
				kept = true;
			}
		}
		if (kept) next.skills[name] = recorded;
	}
	return { files, manifest: next };
}

/** Reads the manifest a checkout holds. A missing or broken one means the bridge has not written here yet. */
export function parseManifest(text: string | null): Manifest {
	if (!text) return EMPTY_MANIFEST;
	try {
		const parsed = JSON.parse(text) as Manifest;
		if (parsed?.version !== 1 || typeof parsed.skills !== 'object' || !parsed.skills)
			return EMPTY_MANIFEST;
		return parsed;
	} catch {
		return EMPTY_MANIFEST;
	}
}

export const manifestText = (manifest: Manifest) => `${JSON.stringify(manifest, null, '\t')}\n`;
