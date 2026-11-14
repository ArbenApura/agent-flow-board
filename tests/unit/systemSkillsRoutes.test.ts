// THE PUBLIC SYSTEM SKILLS ROUTES (AFB-20261021-0401): TYPES, ETAGS, 304, THE ZIP BYTES AND NO CALLER DATA

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { GET as getIndex } from '../../src/routes/api/v1/system-skills/+server';
import { GET as getZip } from '../../src/routes/api/v1/system-skills/bundle.zip/+server';
import { GET as getFile } from '../../src/routes/api/v1/system-skills/files/[name]/[...path]/+server';
import {
	MANIFEST,
	servedFile,
	systemSkillsIndex,
	systemSkillsZip
} from '../../src/lib/server/system-skills';
import { sha256Hex } from '../../src/lib/server/system-skills/hash';

// -- CONSTANTS -- //

const URL_BASE = 'http://localhost:5180/api/v1/system-skills';
const req = (path = '', headers: Record<string, string> = {}) =>
	new Request(`${URL_BASE}${path}`, { headers });
// The handlers read only the request and the params, so a minimal event is enough
const call = <T extends (e: never) => Response | Promise<Response>>(
	h: T,
	request: Request,
	params: Record<string, string> = {}
) => h({ request, params } as never);

// -- TESTS -- //

describe('GET /api/v1/system-skills', () => {
	it('answers the index as JSON with a strong ETag and a public cache header', async () => {
		const res = await call(getIndex, req());
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(res.headers.get('cache-control')).toContain('public');
		expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		const body = (await res.json()) as ReturnType<typeof systemSkillsIndex>;
		expect(body.bundle.version).toBe(MANIFEST.bundle.version);
		expect(body.skills).toHaveLength(Object.keys(MANIFEST.skills).length);
		expect(body.skills.every((s) => s.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)))).toBe(
			true
		);
	});

	it('answers 304 with no body when the caller holds the current version', async () => {
		const first = await call(getIndex, req());
		const again = await call(getIndex, req('', { 'if-none-match': first.headers.get('etag')! }));
		expect(again.status).toBe(304);
		expect(await again.text()).toBe('');
	});

	it('is the same for a caller with a cookie or a token, and sets no cookie', async () => {
		const plain = await call(getIndex, req());
		const signedIn = await call(
			getIndex,
			req('', { cookie: 'session=abc', authorization: 'Bearer secret' })
		);
		expect(await signedIn.text()).toBe(await plain.text());
		expect(signedIn.headers.get('set-cookie')).toBeNull();
		expect(signedIn.headers.get('vary')).toBeNull();
	});
});

describe('GET /api/v1/system-skills/bundle.zip', () => {
	it('serves the stored zip as a download named for the bundle version', async () => {
		const res = await call(getZip, req('/bundle.zip'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/zip');
		expect(res.headers.get('content-disposition')).toContain(
			`agent-flow-board-skills-${MANIFEST.bundle.version}.zip`
		);
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes).toEqual(systemSkillsZip());
		// A zip starts with a local file header
		expect(bytes[0]).toBe(0x50);
		expect(bytes[1]).toBe(0x4b);
	});

	it('has its own ETag, apart from the index', async () => {
		const zip = await call(getZip, req('/bundle.zip'));
		const index = await call(getIndex, req());
		expect(zip.headers.get('etag')).not.toBe(index.headers.get('etag'));
	});
});

describe('GET /api/v1/system-skills/files/<name>/<path>', () => {
	it('serves a stamped SKILL.md as Markdown whose hash is the one the index lists', async () => {
		const index = systemSkillsIndex();
		for (const s of index.skills)
			for (const f of s.files) {
				const res = await call(getFile, req(`/files/${s.name}/${f.path}`), {
					name: s.name,
					path: f.path
				});
				expect(res.status, `${s.name}/${f.path}`).toBe(200);
				expect(res.headers.get('content-type')).toContain('text/markdown');
				const text = await res.text();
				expect(sha256Hex(text)).toBe(f.sha256);
				expect(text).toBe(servedFile(s.name, f.path));
			}
	});

	it('answers 404 for an unknown skill, an unknown file, a path trick and an odd name', async () => {
		for (const params of [
			{ name: 'nope', path: 'SKILL.md' },
			{ name: 'flow', path: 'nope.md' },
			{ name: 'flow', path: '../manifest.json' },
			{ name: '..', path: 'SKILL.md' },
			{ name: 'Flow', path: 'SKILL.md' }
		]) {
			const res = await call(getFile, req(), params);
			expect(res.status, JSON.stringify(params)).toBe(404);
		}
	});
});
