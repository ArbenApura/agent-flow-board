// THE DRIFT GUARD FOR THE SERVED WORKFLOW TEXT (AFB-20261018-0622, ADR 6)
// CI has no .claude or .agents tree (both are outside git), so the tracked workflow-docs are guarded against a tracked hash
// manifest written by yarn skills:sync. Where the repo's own skills are present, a local-only test also compares them with
// the copies and checks the .agents mirror, and is visibly skipped when .claude is missing.

// -- DEP-MODULES -- //
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	DOCS_DIR,
	MANIFEST_FILE,
	SKILL_SOURCES,
	hashOf,
	readDoc,
	stripFrontMatter
} from '../../src/lib/server/skills/docs';

// -- TYPES -- //

type Manifest = {
	version: number;
	files: { file: string; skill: string; source: string; hash: string }[];
};

// -- CONSTANTS -- //

const manifest = JSON.parse(readDoc('manifest.json')) as Manifest;
const LOCAL = existsSync(join(process.cwd(), '.claude', 'skills'));
const local = (path: string) => stripFrontMatter(readFileSync(join(process.cwd(), path), 'utf8'));

// -- TESTS -- //

describe('the served workflow copies', () => {
	it('match the tracked manifest, so a hand edit without yarn skills:sync fails CI', () => {
		expect(manifest.version).toBe(1);
		expect(manifest.files.map((f) => f.file)).toEqual(SKILL_SOURCES.map((s) => s.file));
		for (const entry of manifest.files) {
			expect(hashOf(readDoc(entry.file)), entry.file).toBe(entry.hash);
			expect(entry.source, entry.file).toBe(
				SKILL_SOURCES.find((s) => s.file === entry.file)?.source
			);
		}
	});

	it('carry no front matter, so the served text starts with the skill heading', () => {
		for (const { file } of SKILL_SOURCES) {
			const text = readDoc(file);
			expect(text.startsWith('---'), file).toBe(false);
			expect(text.endsWith('\n'), file).toBe(true);
			expect(text, file).not.toContain('\r\n');
		}
	});

	it('are listed in one place, so a new skill cannot be served without being copied', () => {
		// The seven workflows the MCP serves and the seven skill files of this guard are the same list
		expect(
			SKILL_SOURCES.filter((s) => /^flow(-[a-z]+)?\.md$/.test(s.file)).map((s) => s.file)
		).toEqual([
			'flow.md',
			'flow-task.md',
			'flow-interview.md',
			'flow-critic.md',
			'flow-audit.md',
			'flow-check.md',
			'flow-verify.md'
		]);
		expect(DOCS_DIR.replaceAll('\\', '/').endsWith('mcp/workflow-docs')).toBe(true);
		expect(MANIFEST_FILE).toBe(join(DOCS_DIR, 'manifest.json'));
	});
});

// Locally the skills themselves are present; on CI they are not, and this whole block is skipped without failing
describe.skipIf(!LOCAL)('the repo skills and their copies', () => {
	it('are byte for byte the served copies, once the front matter is removed', () => {
		for (const { file, source } of SKILL_SOURCES) expect(local(source), file).toBe(readDoc(file));
	});

	it('mirror into .agents, which the other harnesses read', () => {
		if (!existsSync(join(process.cwd(), '.agents', 'skills'))) return;
		for (const { source } of SKILL_SOURCES) {
			const mirrored = source.replace('.claude/skills/', '.agents/skills/');
			expect(existsSync(join(process.cwd(), mirrored)), mirrored).toBe(true);
			expect(local(mirrored), mirrored).toBe(local(source));
		}
	});
});
