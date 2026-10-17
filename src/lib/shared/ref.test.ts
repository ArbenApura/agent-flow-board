import { describe, expect, it } from 'vitest';
import { isItemRef, isStampRef, legacyMoment, refCandidates, stampOf } from './ref';

describe('the stamp is UTC', () => {
	it('is the date and the minute, in UTC', () => {
		expect(stampOf(new Date('2026-10-17T09:50:52Z'))).toBe('20261017-0950');
		// 23:59 in UTC is still the old day, whatever the machine clock says
		expect(stampOf(new Date('2026-12-31T23:59:59Z'))).toBe('20261231-2359');
		expect(stampOf(new Date('2027-01-01T00:00:00Z'))).toBe('20270101-0000');
	});

	it('does not move with an offset in the date text', () => {
		// 2026-10-18 01:30 in +08:00 is 2026-10-17 17:30 in UTC
		expect(stampOf(new Date('2026-10-18T01:30:00+08:00'))).toBe('20261017-1730');
	});
});

describe('the candidates of a minute', () => {
	it('start with the plain stamp, then -b to -z, 26 in all', () => {
		const list = refCandidates('HAPR', new Date('2026-10-17T09:50:00Z'));
		expect(list).toHaveLength(26);
		expect(list[0]).toBe('HAPR-20261017-0950');
		expect(list[1]).toBe('HAPR-20261017-0950-b');
		expect(list[25]).toBe('HAPR-20261017-0950-z');
	});

	it('can start at a suffix, leaving the plain stamp to another item', () => {
		const list = refCandidates('HAPR', new Date('2026-10-17T09:50:00Z'), 'c');
		expect(list[0]).toBe('HAPR-20261017-0950-c');
		expect(list).toHaveLength(24);
		expect(list).not.toContain('HAPR-20261017-0950');
	});

	it('are all stamp references', () => {
		for (const c of refCandidates('AB1', new Date('2026-01-02T03:04:00Z')))
			expect(isStampRef(c), c).toBe(true);
	});
});

describe('which text is a reference', () => {
	it('accepts the stamp form and the old number form, nothing else', () => {
		for (const ok of ['HAPR-20261017-0950', 'HAPR-20261017-0950-b', 'HAPR-2', 'CKT-1234', 'A1-5'])
			expect(isItemRef(ok), ok).toBe(true);
	});

	it('refuses anything a shell, a link or a prompt could misuse', () => {
		for (const bad of [
			'hapr-2',
			'HAPR-',
			'HAPR-2 x',
			'HAPR-2"; calc',
			'HAPR-2\n',
			'$(x)-1',
			'',
			'HAPR-20261017-0950-B',
			'HAPR-20261017-0950-bb',
			'HAPR-2026101-0950',
			'FLOW-20261014-1047 ',
			'HAPR-20261017-0950\n'
		])
			expect(isItemRef(bad), JSON.stringify(bad)).toBe(false);
	});

	it('a legacy Board id has the stamp shape, so it is accepted as one', () => {
		expect(isStampRef('FLOW-20261014-1047')).toBe(true);
	});
});

describe('a legacy HAPR Board id', () => {
	it('is read as +08:00 and returned as UTC', () => {
		const m = legacyMoment('FLOW-20261014-1047');
		expect(m?.at.toISOString()).toBe('2026-10-14T02:47:00.000Z');
		expect(m?.suffix).toBe('');
	});

	it('crosses midnight into the day before in UTC', () => {
		expect(legacyMoment('FLOW-20261014-0130')?.at.toISOString()).toBe('2026-10-13T17:30:00.000Z');
	});

	it('keeps a suffix', () => {
		const m = legacyMoment('FLOW-20261014-1047-b');
		expect(m?.suffix).toBe('b');
		expect(m?.at.toISOString()).toBe('2026-10-14T02:47:00.000Z');
	});

	it('gives nothing for an id without a real date and time', () => {
		for (const bad of [
			'FLOW-20261014-2460',
			'FLOW-20261014-2400',
			'FLOW-20261314-1047',
			'FLOW-20260231-1047',
			'FLOW-20261014',
			'HAPR-20261014-1047',
			'FLOW-20261014-1047-bb',
			''
		])
			expect(legacyMoment(bad), JSON.stringify(bad)).toBeNull();
	});
});
