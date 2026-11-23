import { describe, expect, it } from 'vitest';
import {
	CONTINUE_ACTIONS,
	IDEA_LIMIT,
	buildCreatePrompt,
	buildNotePrompt,
	buildPrompt,
	cleanIdea,
	createPrefix,
	isProjectKey,
	isRef,
	noteIdea,
	slashCommand,
	type ContinueAction
} from './continue';

const ATTACKS = [
	'x $(Start-Process calc)',
	'x `calc`',
	'x"; calc; "',
	'echo %PATH%',
	'run !!',
	'one\ntwo',
	"it's",
	'a & b | c',
	'$env:USERPROFILE',
	'back\\slash'
];
const prompt = (action: ContinueAction) => buildPrompt({ action, ref: 'HAPR-2' });

describe('every item prompt is the slash command of the /flow skills', () => {
	it('uses the /flow skills in the same shape as the HAPR Board', () => {
		expect(prompt('resume')).toBe('/flow resume HAPR-2');
		expect(prompt('audit')).toBe('/flow-audit HAPR-2');
		expect(prompt('critic')).toBe('/flow-critic-code HAPR-2');
		expect(prompt('interview')).toBe('/flow-interview HAPR-2');
		expect(prompt('ask')).toBe('/flow HAPR-2: ');
	});

	it('is written for every action and carries no title and no address', () => {
		for (const action of CONTINUE_ACTIONS) {
			const text = prompt(action);
			expect(text, action).toContain('HAPR-2');
			expect(text, action).not.toContain('http');
		}
	});

	it('writes the stamp form of a new item, with or without a suffix', () => {
		expect(slashCommand('resume', 'HAPR-20261017-0950')).toBe('/flow resume HAPR-20261017-0950');
		expect(slashCommand('audit', 'HAPR-20261017-0950-b')).toBe('/flow-audit HAPR-20261017-0950-b');
		expect(slashCommand('ask', 'HAPR-20261017-0950')).toBe('/flow HAPR-20261017-0950: ');
	});

	it('refuses a stamp that is not exactly one the app writes', () => {
		for (const bad of [
			'HAPR-20261017-0950-B',
			'HAPR-20261017-0950-bb',
			'HAPR-2026101-0950',
			'HAPR-20261017-0950"; calc',
			'HAPR-20261017-0950\n',
			'hapr-20261017-0950'
		])
			expect(slashCommand('resume', bad), bad).toBeNull();
	});

	it('gives an empty prompt for a reference the app would not write', () => {
		for (const bad of ['hapr-2', 'HAPR-', 'HAPR-2 x', 'HAPR-2"; calc', 'HAPR-2\n', '$(x)-1', '']) {
			expect(slashCommand('resume', bad), bad).toBeNull();
			expect(buildPrompt({ action: 'resume', ref: bad }), bad).toBe('');
		}
	});
});

describe('the New plan and New task prompts', () => {
	const make = (kind: 'plan' | 'task', idea: string, key = 'AFB') =>
		buildCreatePrompt({ kind, key, idea });

	it('are the fixed words, a space and the idea', () => {
		expect(make('plan', 'add dark mode')).toBe('/flow new AFB: add dark mode');
		expect(make('task', 'fix the typo')).toBe('/flow-task AFB: fix the typo');
	});

	it('show their fixed words on their own for the read-only part of the idea box', () => {
		expect(createPrefix('plan', 'AFB')).toBe('/flow new AFB:');
		expect(createPrefix('task', 'AFB')).toBe('/flow-task AFB:');
		expect(createPrefix('plan', 'afb')).toBe('');
	});

	it('stay open when the idea is empty, so the dialog can ask for it', () => {
		expect(make('plan', '  ')).toBe('/flow new AFB: ');
		expect(make('task', '')).toBe('/flow-task AFB: ');
	});

	it('carry any text as it is, because the prompt is only ever copied', () => {
		for (const evil of ATTACKS) {
			const text = make('task', evil);
			expect(text, evil).toContain('/flow-task AFB: ');
		}
	});

	it('keep the line breaks of a pasted list and drop other control characters', () => {
		const text = make('task', 'one\r\ntwo \u0000 three\n\n  four');
		expect(text).toBe('/flow-task AFB: one\ntwo three\n\nfour');
		expect(cleanIdea('a\u0007b')).toBe('a b');
	});

	it('cut a very long idea with an ellipsis', () => {
		const idea = 'x'.repeat(IDEA_LIMIT * 3);
		expect(cleanIdea(idea).length).toBe(IDEA_LIMIT);
		expect(cleanIdea(idea).endsWith('…')).toBe(true);
		expect(make('task', idea + 'é'.repeat(3000)).length).toBeLessThan(IDEA_LIMIT + 40);
	});

	it('refuse a project key the app would not write', () => {
		for (const bad of ['', 'a', 'afb', 'A', 'AFB-1', 'AFB"; calc', 'ABCDEFGHIJK', 'AFB\n'])
			expect(make('plan', 'x', bad), bad).toBe('');
		expect(isProjectKey('AFB')).toBe(true);
		expect(isProjectKey('HAPR2')).toBe(true);
	});
});

describe('the Turn into a plan and Turn into tasks prompts of a note', () => {
	it('are the slash commands', () => {
		expect(buildNotePrompt({ kind: 'plan', key: 'AFB', ref: 'N-12' })).toBe(
			'/flow new AFB: from note N-12'
		);
		expect(buildNotePrompt({ kind: 'task', key: 'AFB', ref: 'N-12' })).toBe(
			'/flow-task AFB: from note N-12'
		);
	});

	it('refuse a note reference or a project key the app would not write', () => {
		expect(buildNotePrompt({ kind: 'plan', key: 'AFB', ref: 'N-0' })).toBe('');
		expect(buildNotePrompt({ kind: 'plan', key: 'AFB', ref: 'x; rm' })).toBe('');
		expect(buildNotePrompt({ kind: 'plan', key: 'afb', ref: 'N-1' })).toBe('');
		expect(noteIdea('N-12')).toBe('from note N-12');
		expect(noteIdea('12')).toBe('');
	});
});

describe('isRef', () => {
	it('only accepts a reference the app writes', () => {
		expect(isRef('HAPR-2')).toBe(true);
		expect(isRef('CKT-1234')).toBe(true);
		for (const bad of ['hapr-2', 'HAPR-', 'HAPR-2 x', 'HAPR-2"; calc', 'HAPR-2\n', '$(x)-1', ''])
			expect(isRef(bad), bad).toBe(false);
	});
});
