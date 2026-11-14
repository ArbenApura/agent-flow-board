// MOCKUP READING COST (AFB-20261114-0409, PHASE B): A REPLY CARRIES THE NOTES OF ONE VERSION, NOT ALL OF THEM

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { memoryStorage } from '../../src/lib/server/adapters/storage';
import { createItem } from '../../src/lib/server/ops/items';
import {
	getMockup,
	getMockupDerived,
	publishMockup,
	readMockupHtml,
	readMockupSegments,
	readMockupTrees,
	restoreMockupVersion,
	setVersionRender
} from '../../src/lib/server/ops/mockups';
import {
	getMockupContract,
	listMockupParts,
	publishMockupBundle,
	readMockupPart,
	readProjectShell,
	setProjectShell
} from '../../src/lib/server/ops/mockupParts';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, PLAN, type World } from '../support/ops';

// -- CONSTANTS -- //

const html = (n: number) => new TextEncoder().encode(`<html><body>version ${n}</body></html>`);

// -- FUNCTIONS -- //

describe('mockup reads are light', () => {
	let db: TestDb;
	let w: World;
	const storage = memoryStorage('mockup-read-b-secret-0123456789');
	const as = (who: keyof World['people']) => ({
		...w.ctx(who),
		services: { storage, baseUrl: 'https://afb.test' }
	});

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
	}, 120_000);
	afterAll(() => db?.stop());

	it('carries the notes of the current version only, with a short list of the versions', async () => {
		const p = await createItem(as('member'), {
			project: w.projectKey,
			title: 'Light reads',
			...PLAN
		});
		const first = await publishMockup(
			as('member'),
			{ item: p.ref, keepNotes: 'k1 '.repeat(2000), freeNotes: 'f1 '.repeat(1000) },
			html(1)
		);
		for (let n = 2; n <= 6; n++)
			await publishMockup(
				as('member'),
				{
					mockup: first.mockup.id,
					keepNotes: `k${n} `.repeat(2000),
					freeNotes: `f${n} `.repeat(1000)
				},
				html(n)
			);
		const read = await getMockup(as('viewer'), first.mockup.id);
		expect(read.notes?.keep.startsWith('k6')).toBe(true);
		expect(read.versions).toHaveLength(6);
		for (const v of read.versions) {
			expect(v).not.toHaveProperty('keepNotes');
			expect(v).not.toHaveProperty('freeNotes');
			expect(v.notesChars.keep).toBeGreaterThan(0);
		}
		// Six versions of about 9,000 characters of notes no longer ride along in every reply
		expect(JSON.stringify(read).length).toBeLessThan(14_000);
		const old = await getMockup(as('viewer'), first.mockup.id, 2);
		expect(old.notes?.keep.startsWith('k2')).toBe(true);
	});

	it('publishes a bundle of parts on the project shell, keeps the parts, reads them back and takes notes from the contract (D.1 to D.5)', async () => {
		const shell =
			'<!doctype html><html><head><!--afb-part:head--><!--afb-part:styles--></head><body><nav data-ref="nav">Nav</nav><main><!--afb-part:screens--></main><!--afb-part:behavior--></body></html>';
		// Nobody but a writer saves the shell, and it must have the screens slot
		await expect(
			setProjectShell(as('viewer'), { project: w.projectKey }, new TextEncoder().encode(shell))
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			setProjectShell(
				as('member'),
				{ project: w.projectKey },
				new TextEncoder().encode('<html></html>')
			)
		).rejects.toMatchObject({ code: 'INVALID' });
		expect(await readProjectShell(as('viewer'), w.projectKey)).toBeNull();
		await setProjectShell(as('member'), { project: w.projectKey }, new TextEncoder().encode(shell));
		expect((await readProjectShell(as('viewer'), w.projectKey))?.slots).toContain(
			'<!--afb-part:screens-->'
		);

		const p = await createItem(as('member'), { project: w.projectKey, title: 'Bundle', ...PLAN });
		const contract = JSON.stringify({
			refs: [
				{ ref: 'nav', binding: 'keep' },
				{ ref: 'ghost', binding: 'free', reason: 'Not drawn yet' }
			],
			pairs: [{ ref: 'nav', appSelector: 'nav.main' }]
		});
		const parts = [
			{ kind: 'head', key: 'meta', content: '<title>Bundle</title>' },
			{ kind: 'style', key: 'page', content: '.a{color:red}' },
			{ kind: 'screen', key: 'today', content: '<section data-ref="screen-today">Today</section>' },
			{ kind: 'behavior', key: 'main', content: 'const go = () => 1;' },
			{ kind: 'contract', key: 'contract', content: contract }
		];
		const made = await publishMockupBundle(as('member'), { item: p.ref, parts });
		expect(made.composed.slots.length).toBeGreaterThan(2);
		expect(made.readCost.parts).toBeGreaterThan(2);
		// The contract names a ref the page does not have, and says so
		expect(made.warnings.join(' ')).toMatch(/names 1 data-ref the page does not have \(ghost\)/);
		// The page is the composed one, and it reads part by part like any page
		const page = await readMockupHtml(as('viewer'), made.mockup.id);
		expect(page.html).toContain('<main><section data-ref="screen-today">Today</section></main>');
		const segs = await readMockupSegments(as('viewer'), made.mockup.id);
		expect(segs.segments.map((s) => s.key)).toContain('screen:today');
		// The parts are kept, with the shell as the skeleton, and each one reads back
		const listed = await listMockupParts(as('viewer'), made.mockup.id);
		expect(listed.bundle).toBe(true);
		expect(listed.parts.map((x) => `${x.kind}:${x.key}`)).toEqual([
			'skeleton:shell',
			'head:meta',
			'style:page',
			'screen:today',
			'behavior:main',
			'contract:contract'
		]);
		const one = await readMockupPart(as('viewer'), made.mockup.id, {
			kind: 'screen',
			key: 'today'
		});
		expect(one.content).toContain('Today');
		await expect(
			readMockupPart(as('viewer'), made.mockup.id, { kind: 'screen', key: 'nope' })
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
		// The notes were written from the contract, and the contract reads back
		const read = await getMockup(as('viewer'), made.mockup.id);
		expect(read.notes?.keep).toContain('nav');
		expect(read.notes?.free).toContain('ghost (Not drawn yet)');
		expect((await getMockupContract(as('viewer'), made.mockup.id))?.contract.pairs).toHaveLength(1);
		// A part that has no slot in the skeleton is refused by name, and nothing is published
		await expect(
			publishMockupBundle(as('member'), {
				mockup: made.mockup.id,
				parts: [{ kind: 'surface', key: 'lab', content: '<template id="t-lab"></template>' }]
			})
		).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringMatching(/afb-part:surfaces/)
		});
		expect((await getMockup(as('viewer'), made.mockup.id)).versions).toHaveLength(1);
		// A contract with free lines only does not wipe the keep notes of the version before it
		const next = await publishMockupBundle(as('member'), {
			mockup: made.mockup.id,
			parts: [
				{
					kind: 'screen',
					key: 'today',
					content: '<section data-ref="screen-today">Today two</section>'
				},
				{
					kind: 'contract',
					key: 'contract',
					content: JSON.stringify({
						refs: [{ ref: 'screen-today', binding: 'free', reason: 'Copy changes' }]
					})
				}
			]
		});
		const after = await getMockup(as('viewer'), next.mockup.id);
		expect(after.notes?.keep).toContain('nav');
		expect(after.notes?.free).toContain('screen-today (Copy changes)');
		// The parts of a restore of a restore are still found: version 3 comes from 2, which comes from the bundle at 1
		await restoreMockupVersion(as('member'), made.mockup.id, 1);
		await restoreMockupVersion(as('member'), made.mockup.id, 3);
		const again = await listMockupParts(as('viewer'), made.mockup.id);
		expect(again.version).toBe(4);
		expect(again.bundle).toBe(true);
		expect(
			(await readMockupPart(as('viewer'), made.mockup.id, { kind: 'screen', key: 'today' })).content
		).toContain('Today');
		// A viewer publishes nothing, and a single file has no parts
		await expect(publishMockupBundle(as('viewer'), { item: p.ref, parts })).rejects.toMatchObject({
			code: 'FORBIDDEN'
		});
		const plain = await publishMockup(
			as('member'),
			{
				item: (await createItem(as('member'), { project: w.projectKey, title: 'Plain', ...PLAN }))
					.ref
			},
			html(1)
		);
		expect((await listMockupParts(as('viewer'), plain.mockup.id)).bundle).toBe(false);
	});

	it('stores the quality checks of a render, bounded, and reads trees stored without them (rule R10)', async () => {
		const p = await createItem(as('member'), { project: w.projectKey, title: 'Checks', ...PLAN });
		const made = await publishMockup(as('member'), { item: p.ref }, html(3));
		const check = {
			kind: 'contrast' as const,
			severity: 'fail' as const,
			selector: '[data-ref="cta"]',
			detail: 'Contrast 2.9 is below 4.5 for normal text.'
		};
		// Checks without elements or a picture are stored
		await setVersionRender(as('member'), made.mockup.id, made.version.number, {
			screen: 'page',
			width: 1280,
			checks: [check, { kind: 'tap', severity: 'unknown', detail: 'check could not run: x' }]
		});
		const seen = await readMockupTrees(as('viewer'), made.mockup.id, { screen: 'page' });
		expect(seen.trees).toHaveLength(1);
		expect(seen.trees[0]?.checks).toHaveLength(2);
		expect(seen.trees[0]?.elements).toEqual([]);
		const derived = await getMockupDerived(as('viewer'), made.mockup.id);
		expect(derived.derived?.trees?.find((t) => t.checks)?.checks).toBe(2);
		// A 61-entry array and an unknown kind are refused
		await expect(
			setVersionRender(as('member'), made.mockup.id, made.version.number, {
				screen: 'page',
				width: 1280,
				checks: Array.from({ length: 61 }, () => check)
			})
		).rejects.toThrow();
		await expect(
			setVersionRender(as('member'), made.mockup.id, made.version.number, {
				screen: 'page',
				width: 1280,
				checks: [{ kind: 'skip', severity: 'fail', detail: 'x' } as never]
			})
		).rejects.toThrow();
		// A tree stored before the checks existed reads without them
		const plain = await publishMockup(as('member'), { item: p.ref }, html(4));
		await setVersionRender(as('member'), plain.mockup.id, plain.version.number, {
			screen: 'page',
			width: 1280,
			elements: [{ ref: 'a', selector: '[data-ref="a"]' }]
		});
		const without = await readMockupTrees(as('viewer'), plain.mockup.id, { screen: 'page' });
		expect(without.trees[0]?.elements).toHaveLength(1);
		expect(without.trees[0]?.checks).toBeUndefined();
	});

	it('refuses an undeclared screen before anything is stored, and compares the case (rule R3, B.2)', async () => {
		const p = await createItem(as('member'), { project: w.projectKey, title: 'Declared', ...PLAN });
		const made = await publishMockup(
			as('member'),
			{ item: p.ref },
			new TextEncoder().encode(
				`<html><head><meta name="afb-config" content='{"screens": [["today", "Today"], "consult"]}'></head><body><section data-screen="Cases">Cases</section></body></html>`
			)
		);
		const png = Buffer.from(
			Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
		).toString('base64');
		// A declared key in any letter case, a string-form key and a data-screen hook are all accepted
		await setVersionRender(as('member'), made.mockup.id, 1, {
			screen: 'TODAY',
			width: 1280,
			pngBase64: png
		});
		await setVersionRender(as('member'), made.mockup.id, 1, {
			screen: 'consult',
			width: 1280,
			pngBase64: png
		});
		await setVersionRender(as('member'), made.mockup.id, 1, {
			screen: 'cases',
			width: 1280,
			pngBase64: png
		});
		// The whole page is refused when the version declares screens
		await expect(
			setVersionRender(as('member'), made.mockup.id, 1, {
				screen: 'page',
				width: 1280,
				pngBase64: png
			})
		).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringMatching(/declared screens are: today, consult, cases/)
		});
		// An undeclared screen is refused too, and a refusal stores nothing
		const before = await readMockupTrees(as('viewer'), made.mockup.id);
		await expect(
			setVersionRender(as('member'), made.mockup.id, 1, {
				screen: 'nope',
				width: 1280,
				pngBase64: png
			})
		).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringMatching(/"nope" is not declared/)
		});
		const after = await readMockupTrees(as('viewer'), made.mockup.id);
		expect(after.trees.map((t) => [t.screen, t.width]).sort()).toEqual(
			before.trees.map((t) => [t.screen, t.width]).sort()
		);
		// A version with no declared screens accepts the page
		const plain = await publishMockup(as('member'), { item: p.ref }, html(2));
		await setVersionRender(as('member'), plain.mockup.id, plain.version.number, {
			screen: 'page',
			width: 1280,
			pngBase64: png
		});
		// A CSS attribute selector inside a style block is styling, never a declaration: the page still renders
		const styled = await publishMockup(
			as('member'),
			{ item: p.ref },
			new TextEncoder().encode(
				`<html><head><style>[data-screen="reading"] .x { color: red; }</style></head><body><main>Page</main></body></html>`
			)
		);
		await setVersionRender(as('member'), styled.mockup.id, styled.version.number, {
			screen: 'page',
			width: 1280,
			pngBase64: png
		});
	});

	it('saves a render (picture and rendered tree) per screen, state and width, and a second one replaces the first (C.2)', async () => {
		const p = await createItem(as('member'), { project: w.projectKey, title: 'Renders', ...PLAN });
		const made = await publishMockup(as('member'), { item: p.ref }, html(1));
		const png = Buffer.from(
			Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
		).toString('base64');
		const tree = (text: string) => [
			{
				ref: 'nav',
				selector: '[data-ref="nav"]',
				visible: true,
				box: { x: 0, y: 0, w: 264, h: 800 },
				text
			}
		];
		await setVersionRender(as('member'), made.mockup.id, 1, {
			screen: 'today',
			width: 1280,
			pngBase64: png,
			elements: tree('Today')
		});
		await setVersionRender(as('member'), made.mockup.id, 1, {
			screen: 'today',
			width: 408,
			elements: tree('Today phone')
		});
		let seen = await readMockupTrees(as('viewer'), made.mockup.id, { screen: 'today' });
		expect(seen.available).toBe(2);
		expect(seen.trees.map((t) => t.width).sort((a, b) => a - b)).toEqual([408, 1280]);
		// The same screen, state and width again replaces the tree
		await setVersionRender(as('member'), made.mockup.id, 1, {
			screen: 'today',
			width: 1280,
			elements: tree('Today again')
		});
		seen = await readMockupTrees(as('viewer'), made.mockup.id, { screen: 'today', width: 1280 });
		expect(seen.trees).toHaveLength(1);
		expect(JSON.stringify(seen.trees[0].elements)).toContain('Today again');
		// The bridge takes its pictures as JPEG: that is stored with its own type, and anything else is refused
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64');
		await setVersionRender(as('member'), made.mockup.id, 1, {
			screen: 'today',
			width: 820,
			pngBase64: jpeg
		});
		const derived = await getMockupDerived(as('viewer'), made.mockup.id);
		expect(derived.derived?.shots.find((s) => s.width === 820)?.mime).toBe('image/jpeg');
		await expect(
			setVersionRender(as('member'), made.mockup.id, 1, {
				screen: 'today',
				width: 1000,
				pngBase64: Buffer.from('not a picture').toString('base64')
			})
		).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/PNG or a JPEG/) });
		// Nothing is saved for a viewer, an empty call or a version that does not exist
		await expect(
			setVersionRender(as('viewer'), made.mockup.id, 1, {
				screen: 'today',
				width: 1280,
				elements: []
			})
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(
			setVersionRender(as('member'), made.mockup.id, 1, { screen: 'today', width: 1280 })
		).rejects.toMatchObject({ code: 'INVALID' });
		await expect(
			setVersionRender(as('member'), made.mockup.id, 9, {
				screen: 'today',
				width: 1280,
				elements: []
			})
		).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});
});
