// THE SYSTEM SKILLS BUNDLE (AFB-20261021-0401): THE MANIFEST, THE VERSION GUARD, THE SERVED TEXT AND THE ZIP
// A skill text changed without a version bump fails here, so nobody ships a changed skill under an old version number.

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
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
import {
	WORKFLOWS,
	WORKFLOW_FILE_NAMES,
	WORKFLOW_FILES,
	workflowFile
} from '../../src/lib/server/mcp/workflows';

// -- CONSTANTS -- //

const NAMES = [
	'flow',
	'flow-align',
	'flow-audit',
	'flow-commit',
	'flow-critic-code',
	'flow-critic-mockup',
	'flow-critic-plan',
	'flow-critic-screens',
	'flow-decide',
	'flow-interview',
	'flow-mockup',
	'flow-qa',
	'flow-screens',
	'flow-task',
	'flow-update-skills'
];

// -- TESTS -- //

describe('the system skills manifest', () => {
	it('keeps the flow-align rules block true: every rule is a sentence of the flow skill, and the marker carries a version of its own (AFB-20261110-2333)', () => {
		const sources = sourceFiles();
		const block = sources['flow-align'].find((f) => f.path === 'rules-block.md')!.text;
		const flow = sources.flow.find((f) => f.path === 'SKILL.md')!.text;
		const open = /<!-- afb:flow-align rules (\d+\.\d+\.\d+) [^>]*-->/.exec(block);
		expect(open, 'the opening marker').toBeTruthy();
		// The block is versioned by itself: an edit of the skill around it must not make every repo's block look old
		expect(open![1]).toMatch(/^\d+\.\d+\.\d+$/);
		const end = block.indexOf('<!-- /afb:flow-align rules -->');
		expect(end).toBeGreaterThan(open!.index);
		const rules = block
			.slice(open!.index, end)
			.split('\n')
			.filter((l) => l.startsWith('- '))
			.map((l) => l.slice(2).trim());
		expect(rules.length).toBeGreaterThan(5);
		// A rule the flow skill no longer says word for word is drift: change the block and bump flow-align
		for (const rule of rules) expect(flow, rule).toContain(rule);
	});

	it('lists the thirteen flow skills, each with a semver version, and the retired ones apart (AFB-20261116-1457)', () => {
		expect(Object.keys(MANIFEST.skills).sort()).toEqual(NAMES);
		// flow-critic is gone for good: its four reviews stand alone, and an installed copy is deleted by /flow-update-skills (AFB-20261123-1205)
		// flow-critic-screen was renamed flow-critic-screens in bundle 1.27.0, so the old folder name is retired too
		expect([...(MANIFEST.retired ?? [])].sort()).toEqual([
			'flow-check',
			'flow-critic',
			'flow-critic-screen',
			'flow-verify'
		]);
		expect(MANIFEST.removedFiles ?? {}).toEqual({});
		for (const gone of MANIFEST.retired ?? []) expect(MANIFEST.skills[gone], gone).toBeUndefined();
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

	it('read each critic review supporting file from the bundle files, and critic-rules is the same file in all four (AFB-20261123-1205)', () => {
		for (const [name, names] of Object.entries(WORKFLOW_FILES).filter(([n]) =>
			n.startsWith('flow-critic')
		)) {
			const skill = systemSkills().find((s) => s.name === name)!;
			for (const f of names)
				expect(skill.files.find((x) => x.path === `${f}.md`)?.text.trimEnd(), `${name}/${f}`).toBe(
					workflowFile(name, f).trimEnd()
				);
			expect(skill.files.map((f) => f.path).sort(), name).toEqual([
				...[...names]
					.sort()
					.map((f) => `${f}.md`)
					.concat('SKILL.md')
					.sort()
			]);
		}
		expect(systemSkills().find((s) => s.name === 'flow-critic')).toBeUndefined();
		// The shared rules are one text in four places, so a review never reads a different copy from its sibling
		const rules = ['plan', 'code', 'mockup', 'screens'].map((m) =>
			systemSkills()
				.find((s) => s.name === `flow-critic-${m}`)!
				.files.find((f) => f.path === 'critic-rules.md')!
		);
		expect(rules.every((r) => r.text === rules[0].text && r.sha256 === rules[0].sha256)).toBe(true);
		// Every supporting file name is owned by a review, and only critic-rules by all four
		const owned = Object.entries(WORKFLOW_FILES)
			.filter(([n]) => n.startsWith('flow-critic'))
			.flatMap(([, names]) => [...names]);
		// The flow detail files (design, mockup-read, screens) belong to flow, not to a critic review (AFB-20261124-1254)
		const flowOwn = WORKFLOW_FILES.flow;
		expect([...new Set(owned)].sort()).toEqual(
			[...WORKFLOW_FILE_NAMES].filter((n) => !flowOwn.includes(n)).sort()
		);
		expect(owned.filter((n) => n === 'critic-rules')).toHaveLength(4);
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
