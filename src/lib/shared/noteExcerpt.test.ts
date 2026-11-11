// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { noteExcerpt, noteMatch, plainText } from './noteExcerpt';

describe('plainText', () => {
	it('drops headings, emphasis, links, pictures, code marks and table rules', () => {
		const md = [
			'## Licence and openness',
			'- **MIT / Apache-2.0** (dual) for the `code`',
			'- [ ] a box to tick',
			'See [the plan](afb:item/ML-1) and ![a sketch](/p/1.png).',
			'| Phase | What |',
			'|---|:--:|',
			'| 0 | Setup |',
			'> quoted *words*'
		].join('\n');
		expect(plainText(md)).toBe(
			'Licence and openness MIT / Apache-2.0 (dual) for the code a box to tick See the plan and . Phase What 0 Setup quoted words'
		);
	});
});

describe('noteExcerpt', () => {
	it('leaves out a first heading that only repeats the title', () => {
		expect(noteExcerpt('Roadmap overview', '# Roadmap overview\n\nThe build plan of record.')).toBe(
			'The build plan of record.'
		);
	});

	it('keeps a first heading that says something else', () => {
		expect(noteExcerpt('Roadmap', '# Phases\n\nSetup first.')).toBe('Phases Setup first.');
	});

	it('cuts on a word edge with an ellipsis', () => {
		const out = noteExcerpt('T', 'one two three four five six seven eight nine ten', 20);
		expect(out).toBe('one two three four…');
		expect(out.length).toBeLessThanOrEqual(21);
	});
});

describe('noteMatch', () => {
	it('returns the window around the first hit with every hit marked', () => {
		const body = `${'Lead words before the part we want. '.repeat(10)}A breakthrough with tribulation, then a second Tribulation.`;
		const m = noteMatch(body, 'tribulation', 120);
		expect(m).not.toBeNull();
		if (!m) return;
		expect(m.text.startsWith('…')).toBe(true);
		const marked = m.marks.map(([a, b]) => m.text.slice(a, b).toLowerCase());
		expect(marked).toEqual(['tribulation', 'tribulation']);
	});

	it('marks several words without overlap', () => {
		const m = noteMatch('Sword strike and sword stance', 'sword strike');
		expect(m?.marks.map(([a, b]) => m.text.slice(a, b))).toEqual(['Sword', 'strike', 'sword']);
	});

	it('is null when only the title matched', () => {
		expect(noteMatch('Nothing to see here', 'tribulation')).toBeNull();
	});
});
