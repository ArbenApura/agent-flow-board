// TESTS OF REGISTRATION ROUTING: THE ORDER OF THE FOUR WAYS TO CHOOSE, THE HEADER LINE, THE THREE REFUSAL CODES AND THE REAL HEADER LINES OF THE 235 EXISTING CHECK SCRIPTS.

// IMPORTED DEP-MODULES
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// IMPORTED TYPES
import type { Registration } from './types.js';
// IMPORTED MODULES
import { REGISTRATION_NAME } from './registry.js';
import { RegistrationError, pickRegistration, registrationHeader, routeRun } from './routing.js';

// -- CONSTANTS -- //

const LEGACY_CHECKS = 'C:\\Users\\Admin\\Desktop\\afb-checks\\checks\\mangoman';

// -- FUNCTIONS -- //

const reg = (name: string, boardProject: string, org = 'acme'): Registration => ({
	org,
	name,
	boardProject,
	recipe: false,
	database: 'none',
	adoptEnv: false,
	uploadSignedInPictures: false,
	createdAt: '2026-11-08T00:00:00.000Z'
});
const ALL = [
	reg('HAPRM', 'HAPR'),
	reg('HAPRN', 'HAPR'),
	reg('HAPRDOCS', 'DOCS'),
	reg('AFB', 'AFB'),
	reg('HAPRM', 'HAPR', 'other')
];
const refusal = (fn: () => unknown): RegistrationError => {
	try {
		fn();
	} catch (e) {
		if (e instanceof RegistrationError) return e;
		throw e;
	}
	throw new Error('Expected a registration refusal.');
};

describe('registrationHeader', () => {
	it('reads the name from a line among the first 12', () => {
		expect(registrationHeader('// afb-registration: HAPRM\nimport x')).toBe('HAPRM');
		expect(registrationHeader('// a\n// b\n  //   afb-registration:   haprn_1-x  \r\nrest')).toBe(
			'haprn_1-x'
		);
		const eleven = Array.from({ length: 11 }, () => '// x').join('\n');
		expect(registrationHeader(`${eleven}\n// afb-registration: LAST`)).toBe('LAST');
	});
	it('ignores a line after the 12th, a bad name and a trailing word', () => {
		const twelve = Array.from({ length: 12 }, () => '// x').join('\n');
		expect(registrationHeader(`${twelve}\n// afb-registration: LATE`)).toBeNull();
		expect(registrationHeader('// afb-registration: has space')).toBeNull();
		expect(registrationHeader('// afb-registration: A/B')).toBeNull();
		expect(registrationHeader(`// afb-registration: ${'A'.repeat(33)}`)).toBeNull();
		expect(registrationHeader('const x = 1; // afb-registration: HAPRM')).toBeNull();
		expect(registrationHeader('')).toBeNull();
	});
});

describe('pickRegistration', () => {
	it('uses the one that is named, without regard to case, with or without the organisation', () => {
		expect(pickRegistration('acme', 'HAPR', 'haprn', ALL).name).toBe('HAPRN');
		expect(pickRegistration('acme', 'HAPR', 'acme/HAPRM', ALL)).toMatchObject({
			name: 'HAPRM',
			org: 'acme'
		});
	});
	it('uses the only registration of the board project when none is named', () => {
		expect(pickRegistration('acme', 'DOCS', null, ALL).name).toBe('HAPRDOCS');
		expect(pickRegistration('other', 'HAPR', undefined, ALL).org).toBe('other');
	});
	it('REGISTRATION_REQUIRED lists the choices when several serve the project', () => {
		const e = refusal(() => pickRegistration('acme', 'HAPR', null, ALL));
		expect(e.code).toBe('REGISTRATION_REQUIRED');
		expect(e.registrations).toEqual(['HAPRM', 'HAPRN']);
		expect(e.message).toContain('HAPRM, HAPRN');
	});
	it('REGISTRATION_MISMATCH names the registration that serves another project', () => {
		const e = refusal(() => pickRegistration('acme', 'HAPR', 'HAPRDOCS', ALL));
		expect(e.code).toBe('REGISTRATION_MISMATCH');
		expect(e.registrations).toEqual(['HAPRM', 'HAPRN']);
		expect(e.message).toContain('serves the board project DOCS');
	});
	it('REGISTRATION_UNKNOWN for a name nobody holds, a project without registrations and a foreign organisation', () => {
		const a = refusal(() => pickRegistration('acme', 'HAPR', 'NOPE', ALL));
		expect(a.code).toBe('REGISTRATION_UNKNOWN');
		expect(a.registrations).toEqual(['HAPRM', 'HAPRN']);
		const b = refusal(() => pickRegistration('acme', 'ZZZ', null, ALL));
		expect(b.code).toBe('REGISTRATION_UNKNOWN');
		expect(b.registrations).toEqual([]);
		expect(b.message).toContain('check project');
		expect(refusal(() => pickRegistration('acme', 'HAPR', 'beta/HAPRM', ALL)).code).toBe(
			'REGISTRATION_UNKNOWN'
		);
		expect(refusal(() => pickRegistration('acme', 'HAPR', 'a/b/c', ALL)).code).toBe(
			'REGISTRATION_UNKNOWN'
		);
		expect(refusal(() => pickRegistration('acme', 'HAPR', '../x', ALL)).code).toBe(
			'REGISTRATION_UNKNOWN'
		);
	});
	it('never reaches into another organisation', () => {
		const e = refusal(() => pickRegistration('acme', 'HAPR', null, [reg('X', 'HAPR', 'other')]));
		expect(e.code).toBe('REGISTRATION_UNKNOWN');
	});
});

describe('routeRun', () => {
	const script = '// afb-registration: HAPRN\nexport default 1';
	it('prefers the run, then the check, then the script header, then the only registration', () => {
		const base = { org: 'acme', boardProject: 'HAPR', all: ALL };
		expect(routeRun({ ...base, run: 'HAPRM', check: 'HAPRN', script }).name).toBe('HAPRM');
		expect(routeRun({ ...base, check: 'HAPRM', script }).name).toBe('HAPRM');
		expect(routeRun({ ...base, script }).name).toBe('HAPRN');
		expect(routeRun({ org: 'acme', boardProject: 'AFB', all: ALL, script: 'no header' }).name).toBe(
			'AFB'
		);
		expect(refusal(() => routeRun({ ...base, script: 'no header' })).code).toBe(
			'REGISTRATION_REQUIRED'
		);
	});
	it('a header that names a registration of another project is a mismatch', () => {
		expect(
			refusal(() => routeRun({ org: 'acme', boardProject: 'AFB', all: ALL, script })).code
		).toBe('REGISTRATION_MISMATCH');
	});
});

describe('header forms (committed fixtures)', () => {
	// Each form a script of the old tool is written in: line endings, a byte order mark, the header on line 12 or 13, trailing spaces, other letter case
	const cases: { what: string; text: string; expected: string | null }[] = [
		{ what: 'plain', text: '// afb-registration: HAPRM\nexport default 1', expected: 'HAPRM' },
		{
			what: 'CRLF line endings',
			text: '// a\r\n// afb-registration: HAPRM\r\nrest',
			expected: 'HAPRM'
		},
		{
			what: 'a lone CR is not a line end',
			text: '// a\r// afb-registration: HAPRM',
			expected: null
		},
		{ what: 'trailing spaces', text: '// afb-registration: HAPRM   \nx', expected: 'HAPRM' },
		{ what: 'trailing tab and CR', text: '// afb-registration: HAPRM\t\r\nx', expected: 'HAPRM' },
		{
			what: 'a lower case name is kept as written',
			text: '// afb-registration: haprm\nx',
			expected: 'haprm'
		},
		{
			what: 'upper case words around the colon',
			text: '// AFB-REGISTRATION: HAPRM\nx',
			expected: null
		},
		{
			what: 'leading spaces and tabs',
			text: '\t  //\tafb-registration:\tHAPRM\nx',
			expected: 'HAPRM'
		},
		{
			what: 'line 12 (the last line read)',
			text: [...Array.from({ length: 11 }, () => '// x'), '// afb-registration: HAPRM'].join('\n'),
			expected: 'HAPRM'
		},
		{
			what: 'line 13 (too late)',
			text: [...Array.from({ length: 12 }, () => '// x'), '// afb-registration: HAPRM'].join('\n'),
			expected: null
		},
		{
			what: 'a byte order mark in front of a comment on line 1 hides nothing from the later lines',
			text: '\ufeff// first\n// afb-registration: HAPRM',
			expected: 'HAPRM'
		},
		{
			what: 'a byte order mark in front of the header line itself is white space to the pattern',
			text: '\ufeff// afb-registration: HAPRM\nx',
			expected: 'HAPRM'
		},
		{
			what: 'two headers: the first wins',
			text: '// afb-registration: A1\n// afb-registration: B2',
			expected: 'A1'
		},
		{
			what: 'a block comment is not a header',
			text: '/* afb-registration: HAPRM */',
			expected: null
		},
		{ what: 'a name with a space', text: '// afb-registration: HAPR M', expected: null }
	];
	for (const c of cases) it(c.what, () => expect(registrationHeader(c.text)).toBe(c.expected));
});

describe('the real check scripts of the old tool', () => {
	const found = existsSync(LEGACY_CHECKS);
	it.skipIf(!found)(`reads the header lines of every script under ${LEGACY_CHECKS}`, () => {
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				if (statSync(full).isDirectory()) walk(full);
				else if (name.endsWith('.mjs')) files.push(full);
			}
		};
		walk(LEGACY_CHECKS);
		expect(files.length).toBeGreaterThan(0);
		let withHeader = 0;
		let extracted = 0;
		for (const file of files) {
			// Only the first 12 lines are read
			const head = readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 12).join('\n');
			const lines = head.split('\n').filter((l) => l.includes('afb-registration:'));
			const value = registrationHeader(head);
			if (value !== null) extracted++;
			if (lines.length) {
				withHeader++;
				expect(value, `${file}: ${lines[0]}`).not.toBeNull();
				expect(REGISTRATION_NAME.test(value ?? ''), file).toBe(true);
			} else expect(value).toBeNull();
		}
		// Every script that carries a header line yields exactly one name, and no script without one yields any
		expect(extracted).toBe(withHeader);
	});
});
