// A SMALL HAPR BOARD WRITTEN INTO A FOLDER, FOR TESTS: ONE OF EVERY SHAPE THE IMPORTER HAS TO READ (SPEC 13)
// A new style item with a plan, decisions, a settled table, a log, a UI changes table, a public and a private attachment and two
// kit results; a closed legacy item with a frozen percent, an old plan and a decisions file in the old format; an item written
// with a byte order mark and Windows line breaks; a removed row with no folder; tasks; and the ID map.

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// -- CONSTANTS -- //

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
/** A one pixel JPEG header and a few bytes, enough to be a different file with a known checksum. */
export const TINY_JPEG = Buffer.from(
	'/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
	'base64'
);

const write = (path: string, text: string | Buffer) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};

// -- FUNCTIONS -- //

/** Writes the fixture board under `root` (the folder that holds flow, attachments and TASKS.md) and returns the facts the tests check. */
export function makeFixtureBoard(root: string) {
	const itemJson = (o: Record<string, unknown>) =>
		JSON.stringify(
			{
				legacyId: null,
				statusNote: 'Registered',
				dirNote: null,
				branch: 'feat/demo',
				baseRef: 'abc12345',
				external: null,
				legacyPercent: null,
				related: [],
				history: [],
				attachments: [],
				...o
			},
			null,
			2
		);

	// -- A new style item -- //
	const a = join(root, 'flow/features/core/new-thing');
	const publicFile = Buffer.from('# Public note\nSeen by everyone.\n');
	const privateFile = Buffer.from('Private budget sheet\n1,2,3\n');
	const checkJson = JSON.stringify({
		schema: 1,
		run_id: '20261008-100000-aaaa',
		item: 'FLOW-20261010-0900',
		check: 'new-thing',
		target: 'demo',
		deployed_commit: 'deadbeefdeadbeef',
		git: { commit: 'cafebabe', changed_paths: [], dirty_hash: null },
		started: '2026-10-10T02:00:00.000Z',
		ended: '2026-10-10T02:01:30.000Z',
		checks: {
			M1: { title: 'it opens', steps: [{ status: 'pass' }] },
			M2: { title: 'it saves', steps: [{ status: 'pass' }, { status: 'fail' }] }
		},
		run: { status: 'pass', error: null }
	});
	const dataUri = `data:image/jpeg;base64,${TINY_JPEG.toString('base64')}`;
	const shotsJson = JSON.stringify({
		schema: 'ui-shots/1',
		run_id: '20261010-110000-bbbb',
		item: 'FLOW-20261010-0900',
		target: 'local',
		git: { commit: 'cafebabe', dirty_hash: 'abc', changed_paths: ['web/a.svelte'] },
		siblings: {
			'hapr|1440|/home': {
				role: 'sibling',
				route: '/home',
				viewport: '1440',
				image: dataUri,
				brand: 'hapr'
			}
		},
		rows: [
			{
				id: 'r1',
				page: '/new',
				state: 'none',
				brands: ['hapr'],
				siblings: ['/home'],
				levels: ['title'],
				viewports: ['1440'],
				shots: [
					{
						role: 'after',
						route: '/new',
						viewport: '1440',
						brand: 'hapr',
						image: dataUri,
						measure: {
							levels: {
								title: [{ fontSize: 24, fontWeight: 600, height: 32, width: 300, radius: 0 }]
							}
						}
					}
				],
				flags: [
					{
						severity: 'MEDIUM',
						level: 'title',
						brand: 'hapr',
						viewport: '1440',
						route: '/new',
						message: 'the title is larger than its sibling'
					}
				]
			}
		],
		notes: []
	});
	write(
		join(a, 'item.json'),
		itemJson({
			$schema: '../../../schema/item.schema.json',
			id: 'FLOW-20261010-0900',
			title: 'A new thing with a full plan',
			stream: 'features',
			scope: 'core',
			status: 'IN PROGRESS',
			created: '2026-10-10',
			updated: '2026-10-12T15:30:00+08:00',
			tabName: 'NEW_THING',
			visibility: 'public',
			related: [{ id: 'FLOW-20261001-0800', relation: 'follows' }],
			history: [
				{
					at: '2026-10-10T09:00:00+08:00',
					kind: 'status',
					from: null,
					to: 'PLANNED',
					note: 'Registered'
				},
				{
					at: '2026-10-11T10:00:00+08:00',
					kind: 'status',
					from: 'PLANNED',
					to: 'IN PROGRESS',
					note: 'Automatic, a step was ticked'
				}
			],
			attachments: [
				{
					file: '20261010-public-note.md',
					kind: 'document',
					caption: 'A public note about the plan',
					added: '2026-10-10',
					visibility: 'public',
					refs: ['1.1'],
					source: null,
					sha256: sha(publicFile)
				}
			]
		})
	);
	write(join(a, 'attachments/20261010-public-note.md'), publicFile);
	write(
		join(root, 'attachments/FLOW-20261010-0900/manifest.json'),
		JSON.stringify({
			id: 'FLOW-20261010-0900',
			attachments: [
				{
					file: '20261010-budget.csv',
					kind: 'data',
					caption: 'The private budget sheet',
					added: '2026-10-10',
					visibility: 'private',
					refs: [],
					source: 'sir harris',
					sha256: sha(privateFile)
				},
				{
					file: '20261010-browser-check-run-20261008-100000-aaaa.json',
					kind: 'data',
					caption: 'Browser check run 20261008-100000-aaaa M1 and M2 on demo',
					added: '2026-10-10',
					visibility: 'private',
					refs: ['M1', 'M2'],
					source: null,
					sha256: sha(checkJson)
				},
				{
					file: '20261010-ui-shots-run-20261010-110000-bbbb.json',
					kind: 'data',
					caption: 'UI shots run 20261010-110000-bbbb',
					added: '2026-10-10',
					visibility: 'private',
					refs: ['M3'],
					source: null,
					sha256: sha(shotsJson)
				}
			]
		})
	);
	write(join(root, 'attachments/FLOW-20261010-0900/20261010-budget.csv'), privateFile);
	write(
		join(
			root,
			'attachments/FLOW-20261010-0900/20261010-browser-check-run-20261008-100000-aaaa.json'
		),
		checkJson
	);
	write(
		join(root, 'attachments/FLOW-20261010-0900/20261010-ui-shots-run-20261010-110000-bbbb.json'),
		shotsJson
	);
	write(
		join(a, 'SPEC.md'),
		'### Document Metadata & Git Citation\n- **Version**: `1.0.0`\n\n# Spec\n\nThe new thing does one job.\n'
	);
	write(
		join(a, 'PLAN.md'),
		[
			'# Plan',
			'',
			'## Phase 1 Build',
			'- [x] 1.1 Write the code',
			'  - a nested note stays a note',
			'- [ ] 1.2 Write the tests',
			'- [-] 1.3 Skip the old path, Arben waived it',
			'  - Arben, 2026-10-11, not needed any more',
			'## Phase 2 Release',
			'- [x] 2.1 Ship it',
			'- [~] 2.2 Moved to FLOW-20261012-1000',
			'',
			'## Manual checks (not counted)',
			'- [ ] M1 [auto] The page opens',
			'- [-] M2 Arben looks at it on his phone',
			'',
			'## As built',
			'- Phase 1. Built as planned.',
			''
		].join('\n')
	);
	write(
		join(a, 'DECISIONS.md'),
		[
			'# Decisions',
			'',
			'## ADR-001 Use the shared parser',
			'- **Context.** Two copies would drift.',
			'- **Decision.** One parser, used by both.',
			'- **Alternatives.** Copy it.',
			'- **Consequences.** A change reaches both.',
			'',
			'### ADR-002: Keep the old names',
			'#### Context',
			'Old tools read them.',
			'#### Decision',
			'Keep them.',
			'',
			'## Settled without asking',
			'',
			'| Question | Answer | Source |',
			'|---|---|---|',
			'| Does it need a new table? | No | SPEC 3 |',
			'| Who owns it? | The core team | the register \\| row 4 |',
			''
		].join('\n')
	);
	write(
		join(a, 'PROGRESS.md'),
		'# Progress\n\n<!-- flow:state:start sha256=1 (generated) -->\n**Status** `IN PROGRESS`, 66%. Updated now.\n<!-- flow:state:end -->\n### Resume here\nKeep going with 1.2.\n'
	);
	write(
		join(a, 'VALIDATION.md'),
		[
			'# Validation',
			'',
			'### UI changes',
			'| Page | State | Brands | Accounts | Siblings | Levels | Viewports |',
			'|---|---|---|---|---|---|---|',
			'| `/new`, `/new/more` | none, `click:text=Open` | both | default | `/home` | title, section | 1440, 390 |',
			'| `/hub/{event}/rooms` | none | hapr | hapr=iso@example.com | `/home`, `design/screens.html` | body | 1440 |',
			''
		].join('\n')
	);
	write(join(a, 'REFERENCES.md'), '# References\n- https://example.com\n');
	write(join(a, 'FINDINGS.md'), '# Findings\n\nOne finding.\n');
	write(join(a, 'scripts/probe.py'), 'print("not markdown")\n');
	write(
		join(a, 'LOG.md'),
		[
			'# Log',
			'',
			'Append-only.',
			'',
			'- 2026-10-10 09:05, 1.1 done. Wrote the code.',
			'- 2026-10-11 10:00, a line with a, comma and `code`.',
			'- 2026-10-12 15:30, 2.1 done. Shipped.',
			''
		].join('\n')
	);

	// -- A closed legacy item with a frozen percent and an old plan -- //
	const b = join(root, 'flow/fixes/routine/old-fix');
	write(
		join(b, 'item.json'),
		itemJson({
			id: 'FLOW-20260925-1000',
			legacyId: 'FEAT-016',
			title: 'An old fix that was closed',
			stream: 'fixes',
			scope: 'routine',
			status: 'COMPLETED',
			created: '2026-09-25',
			updated: '2026-10-01T09:00:00+08:00',
			legacyPercent: 100,
			history: [{ at: '2026-10-01T09:00:00+08:00', kind: 'note', note: "Closed on Arben's word" }]
		})
	);
	write(
		join(b, 'PLAN.md'),
		'# Old plan\n\n* [x] **Task one**: done long ago\n* [x] Task two\n\n## Phase A Cleanup\n- [x] A.1 Tidy up\n'
	);
	write(
		join(b, 'DECISIONS.md'),
		'# Notes\n\nWe chose the simple way because it is simple. No headings here.\n'
	);
	write(join(b, 'SPEC.md'), 'Spec of the old fix.\n');

	// -- An item written on Windows with a byte order mark and CRLF -- //
	const c = join(root, 'flow/investigations/schemas/windows-note');
	write(
		join(c, 'item.json'),
		itemJson({
			id: 'FLOW-20261011-0800',
			title: 'Written on Windows',
			stream: 'investigations',
			scope: 'schemas',
			status: 'PLANNED',
			created: '2026-10-11',
			updated: '2026-10-11T08:00:00+08:00',
			visibility: 'private'
		})
	);
	write(
		join(c, 'SPEC.md'),
		Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from('# Spec\r\n\r\nLines end with CRLF.\r\n')
		])
	);
	write(join(c, 'PLAN.md'), '## Phase 1 Look\r\n- [ ] 1.1 Look at it\r\n');

	// -- A row with no folder, the ID map, tasks -- //
	write(
		join(root, 'flow/removed-items.json'),
		JSON.stringify({
			items: [
				{
					id: 'FLOW-20260921-1405',
					legacyId: 'FEAT-003',
					stream: 'refactors',
					scope: 'routes',
					status: 'COMPLETED',
					percent: 100,
					reason: 'removed',
					dirNote: '`sourcing-requirements-refactor/`, removed in `da8907b4`',
					branch: '`refactor/old`',
					baseRef: 'd8545916',
					updated: '2026-09-19'
				}
			]
		})
	);
	write(
		join(root, 'flow/ID-MAP.md'),
		'# ID map\n\n| Legacy | FLOW id | Stamp | Folder |\n|---|---|---|---|\n| `FEAT-003` | `FLOW-20260921-1405` | `20260921T14:05` | `sourcing-requirements-refactor (removed)` |\n| `FEAT-016` | `FLOW-20260925-1000` | `20260925T10:00` | `old-fix` |\n'
	);
	write(
		join(root, 'flow/history-legacy.md'),
		'# History\n\n| Version | Date |\n|---|---|\n| `1.0.0` | `2026-09-18` |\n| `1.1.0` | `2026-09-19` |\n'
	);
	write(
		join(root, 'TASKS.md'),
		[
			'# Task list',
			'',
			'**Last updated:** 2026-10-14',
			'',
			'---',
			'',
			'## Billing',
			'',
			'### T-01 First task',
			'- **Task:** Do the first thing.',
			'- **Status:** `DONE`',
			'- **Priority:** -',
			'- **Links:** FLOW-20261010-0900 A new thing, `.board/flow/features/core/new-thing/`',
			'- **Notes:** Done on demo.',
			'- **Updated:** 2026-10-07',
			'',
			'## Later',
			'',
			'### T-02 Maybe later',
			'- **Task:** Think about it.',
			'- **Status:** `FUTURE`',
			'- **Priority:** high',
			'- **Links:** none',
			'- **Notes:** Not now.',
			'- **Updated:** 2026-10-08',
			''
		].join('\n')
	);

	return {
		items: ['FLOW-20260925-1000', 'FLOW-20261010-0900', 'FLOW-20261011-0800'],
		removed: ['FLOW-20260921-1405'],
		tasks: 2,
		publicFile,
		privateFile
	};
}
