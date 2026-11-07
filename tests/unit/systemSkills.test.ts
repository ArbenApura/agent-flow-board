// THE SYSTEM SKILLS BUNDLE (AFB-20261021-0401): THE MANIFEST, THE VERSION GUARD, THE SERVED TEXT AND THE ZIP
// A skill text changed without a version bump fails here, so nobody ships a changed skill under an old version number.

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	MANIFEST,
	bundleSha256,
	servedFile,
	skillBody,
	sourceFiles,
	systemSkills,
	systemSkillsIndex,
	systemSkillsZip
} from '../../src/lib/server/system-skills';
import {
	frontMatterKeys,
	sha256Hex,
	skillHash,
	stampSkill,
	stripFrontMatter,
	unstampSkill
} from '../../src/lib/server/system-skills/hash';
import { crc32, zipStored } from '../../src/lib/server/system-skills/zip';
import { WORKFLOWS, WORKFLOW_FILE_NAMES, workflowFile } from '../../src/lib/server/mcp/workflows';

// -- CONSTANTS -- //

const NAMES = [
	'flow',
	'flow-audit',
	'flow-check',
	'flow-critic',
	'flow-interview',
	'flow-mockup',
	'flow-task',
	'flow-verify'
];

// -- TESTS -- //

describe('the system skills manifest', () => {
	it('lists the eight flow skills, each with a semver version', () => {
		expect(Object.keys(MANIFEST.skills).sort()).toEqual(NAMES);
		expect(MANIFEST.bundle.version).toMatch(/^\d+\.\d+\.\d+$/);
		for (const [name, entry] of Object.entries(MANIFEST.skills))
			expect(entry.version, name).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it('records the hash of every skill under its current version, so a changed text needs a version bump', () => {
		const sources = sourceFiles();
		for (const [name, entry] of Object.entries(MANIFEST.skills)) {
			const recorded = entry.history.find((h) => h.version === entry.version);
			expect(recorded, `${name} has no history entry for ${entry.version}`).toBeTruthy();
			// Edit a skill, bump its version in manifest.json, then run yarn skills:sync
			expect(skillHash(sources[name]), `${name} changed without a version bump`).toBe(
				recorded!.hash
			);
		}
	});

	it('keeps one changelog entry for the bundle version, naming the skill versions it holds', () => {
		const latest = MANIFEST.changelog[0];
		expect(latest.version).toBe(MANIFEST.bundle.version);
		expect(latest.notes.length).toBeGreaterThan(0);
		for (const [name, entry] of Object.entries(MANIFEST.skills))
			expect(latest.skills[name], `${name} is not in the latest changelog entry`).toBe(
				entry.version
			);
	});

	it('has a SKILL.md with a name and a description for every skill', () => {
		for (const [name, files] of Object.entries(sourceFiles())) {
			const keys = frontMatterKeys(files.find((f) => f.path === 'SKILL.md')!.text);
			expect(keys.name, name).toBe(name);
			expect(keys.description?.length, name).toBeGreaterThan(20);
		}
	});
});

describe('the installed files', () => {
	it('carry the bundle, the version and the source hash in the SKILL.md front matter only', () => {
		for (const skill of systemSkills()) {
			const md = skill.files.find((f) => f.path === 'SKILL.md')!;
			const keys = frontMatterKeys(md.text);
			expect(keys['afb-bundle']).toBe(MANIFEST.bundle.version);
			expect(keys['afb-version']).toBe(skill.version);
			expect(keys.name).toBe(skill.name);
			for (const f of skill.files.filter((x) => x.path !== 'SKILL.md'))
				expect(f.text, f.path).not.toContain('afb-source-sha256');
		}
	});

	it('hash back to the stamp once the three stamp lines are removed', () => {
		for (const skill of systemSkills()) {
			const md = skill.files.find((f) => f.path === 'SKILL.md')!;
			const stamp = frontMatterKeys(md.text)['afb-source-sha256'];
			expect(sha256Hex(unstampSkill(md.text)), skill.name).toBe(stamp);
		}
	});

	it('stamp a front matter and refuse a file without one', () => {
		const stamped = stampSkill('---\nname: x\ndescription: y\n---\n\n# X\n', '2.0.0', '1.3.0');
		expect(stamped.startsWith('---\nname: x\ndescription: y\nafb-bundle: 2.0.0\n')).toBe(true);
		expect(() => stampSkill('# No front matter', '1.0.0', '1.0.0')).toThrow();
	});

	it('are the same as the index lists, with a sha256 that matches each file', () => {
		const index = systemSkillsIndex();
		expect(index.bundle.sha256).toBe(bundleSha256());
		expect(index.skills.map((s) => s.name)).toEqual(Object.keys(MANIFEST.skills));
		for (const s of index.skills)
			for (const f of s.files)
				expect(sha256Hex(servedFile(s.name, f.path)!), f.path).toBe(f.sha256);
		expect(servedFile('flow', 'nope.md')).toBeNull();
		expect(servedFile('nope', 'SKILL.md')).toBeNull();
	});

	it('carry no token, host or organisation, so the same bytes go to every caller', () => {
		const all = systemSkills()
			.flatMap((s) => s.files.map((f) => f.text))
			.join('\n');
		expect(all).not.toMatch(/afb_[A-Za-z0-9]{16,}/);
		expect(all).not.toMatch(/Bearer [A-Za-z0-9]{16,}/);
	});
});

describe('workflow_get and the bundle', () => {
	it('serve the same skill texts, the workflow without its front matter', () => {
		for (const name of NAMES) {
			const body = skillBody(name).trim();
			expect(WORKFLOWS.find((w) => w.name === name)!.body, name).toContain(body);
			expect(body.startsWith('---')).toBe(false);
		}
		expect(stripFrontMatter('---\nname: a\n---\n\n# A\n')).toBe('# A\n');
	});

	it('read each flow-critic supporting file from the bundle files', () => {
		const critic = systemSkills().find((s) => s.name === 'flow-critic')!;
		for (const f of WORKFLOW_FILE_NAMES)
			expect(critic.files.find((x) => x.path === `${f}.md`)?.text.trimEnd(), f).toBe(
				workflowFile(f).trimEnd()
			);
		expect(critic.files.map((f) => f.path).sort()).toEqual([
			'SKILL.md',
			...WORKFLOW_FILE_NAMES.map((f) => `${f}.md`)
		]);
	});
});

describe('the zip', () => {
	/** Reads a stored zip back: the entries by path, with their crc checked. */
	function unzip(data: Uint8Array): Record<string, string> {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const end = data.length - 22;
		expect(view.getUint32(end, true)).toBe(0x06054b50);
		const count = view.getUint16(end + 10, true);
		let at = view.getUint32(end + 16, true);
		const out: Record<string, string> = {};
		for (let i = 0; i < count; i++) {
			expect(view.getUint32(at, true)).toBe(0x02014b50);
			const crc = view.getUint32(at + 16, true);
			const size = view.getUint32(at + 24, true);
			const nameLen = view.getUint16(at + 28, true);
			const local = view.getUint32(at + 42, true);
			const name = new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLen));
			const start =
				local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
			const body = data.subarray(start, start + size);
			expect(crc32(body), name).toBe(crc);
			out[name] = new TextDecoder().decode(body);
			at += 46 + nameLen;
		}
		return out;
	}

	it('holds exactly the files of the bundle, as installed', () => {
		const entries = unzip(systemSkillsZip());
		const expected = systemSkills().flatMap((s) => s.files.map((f) => `${s.name}/${f.path}`));
		expect(Object.keys(entries)).toEqual(expected);
		for (const s of systemSkills())
			for (const f of s.files) expect(entries[`${s.name}/${f.path}`]).toBe(f.text);
	});

	it('is built once per process', () => {
		expect(systemSkillsZip()).toBe(systemSkillsZip());
	});

	it('round trips a small archive with a UTF-8 name', () => {
		const data = new TextEncoder().encode('héllo');
		expect(unzip(zipStored([{ path: 'a/é.md', data }]))).toEqual({ 'a/é.md': 'héllo' });
		expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
	});
});

// -- DRIFT GUARD (AFB-20261105-0653, TASK T-1) -- //

describe('drift between the served texts and the skill sources', () => {
	it('changes the skill hash when one byte of any text changes, so a text cannot change under the same version', () => {
		const files = sourceFiles();
		for (const [name, list] of Object.entries(files)) {
			const base = skillHash(list);
			const changed = list.map((f, i) => (i === 0 ? { ...f, text: `${f.text}.` } : f));
			expect(skillHash(changed), `${name} hash ignores a changed byte`).not.toBe(base);
		}
	});

	it('serves every workflow body from exactly the source text of its skill', () => {
		for (const w of WORKFLOWS) {
			const src = skillBody(w.name).trim();
			expect(src.length, `${w.name} has no text`).toBeGreaterThan(200);
			expect(w.body.includes(src), `${w.name}: served body differs from the source`).toBe(true);
		}
	});

	it('keeps the local .claude/skills copy equal to the source after line ending normalisation (skipped when the folder is absent)', async () => {
		const { existsSync, readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const root = join(process.cwd(), '.claude', 'skills');
		if (!existsSync(root)) return;
		for (const [name, list] of Object.entries(sourceFiles())) {
			for (const f of list) {
				const path = join(root, name, f.path);
				if (!existsSync(path)) continue;
				const local = stripFrontMatter(readFileSync(path, 'utf8')).replace(/\r\n/g, '\n').trim();
				const body = stripFrontMatter(f.text).replace(/\r\n/g, '\n').trim();
				expect(
					local === body,
					`${name}/${f.path}: .claude/skills differs, run yarn skills:sync`
				).toBe(true);
			}
		}
	});
});
