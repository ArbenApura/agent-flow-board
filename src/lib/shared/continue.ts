// CONTINUE WITH A CODING TOOL: THE PROMPT THAT HANDS AN ITEM, A NEW PLAN OR A NEW TASK TO THE PERSON'S TOOL (FLOW-20261017-0916)
// The only way out is Copy prompt, so every prompt is the slash command of the /flow skills. Nothing here is put into a shell command.

// IMPORTED MODULES
import { isItemRef } from './ref';

// -- TYPES -- //

export type ContinueAction = 'resume' | 'ask' | 'audit' | 'critic' | 'interview';
/** What the person starts from the New plan and New task buttons: nothing exists yet, so there is no reference, only an idea. */
export type CreateKind = 'plan' | 'task';

// -- CONSTANTS -- //

export const CONTINUE_ACTIONS: readonly ContinueAction[] = [
	'resume',
	'ask',
	'audit',
	'critic',
	'interview'
];
/** The short name on the button of an action. */
export const ACTION_LABEL: Record<ContinueAction, string> = {
	resume: 'Resume',
	ask: 'Ask',
	audit: 'Audit',
	critic: 'Review',
	interview: 'Interview'
};
/** How the dialog names an action in its title. */
export const ACTION_TITLE: Record<ContinueAction, string> = {
	resume: 'Resume',
	ask: 'Ask about',
	audit: 'Audit',
	critic: 'Review',
	interview: 'Interview about'
};
/** The workflow each action runs. */
const WORKFLOW: Record<ContinueAction, string> = {
	resume: 'flow',
	ask: 'flow',
	audit: 'flow-audit',
	critic: 'flow-critic',
	interview: 'flow-interview'
};
/** The longest idea the create prompt carries. */
export const IDEA_LIMIT = 2000;
/** How the dialog names a create action in its title and above the idea box. */
export const CREATE_TITLE: Record<CreateKind, string> = { plan: 'New plan', task: 'New task' };
export const CREATE_QUESTION: Record<CreateKind, string> = {
	plan: 'What do you want to build?',
	task: 'What needs doing?'
};
/** A project key as the app writes it: 2 to 10 capitals or digits, the first a capital. */
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
/** The idea the Turn into a plan and Turn into tasks actions of a note start from: `from note N-12`. */
const NOTE_IDEA = /^from note N-[1-9][0-9]{0,8}$/;

// -- FUNCTIONS -- //

/** An item reference as the app writes it: the stamp form (HAPR-20261017-0950) or the old number form (HAPR-2), nothing else. */
export const isRef = isItemRef;

/**
 * The slash command of the /flow skills: `/flow resume REF`, `/flow-audit REF`, `/flow-critic REF`, `/flow-interview REF` and
 * `/flow REF: ` for a question. Null for a reference the app would not write.
 */
export function slashCommand(action: ContinueAction, ref: string): string | null {
	if (!isRef(ref)) return null;
	switch (action) {
		case 'resume':
			return `/flow resume ${ref}`;
		case 'ask':
			return `/flow ${ref}: `;
		default:
			return `/${WORKFLOW[action]} ${ref}`;
	}
}

/** The prompt of an item action, to copy. Empty for a reference the app would not write. */
export const buildPrompt = (input: { action: ContinueAction; ref: string }): string =>
	slashCommand(input.action, input.ref) ?? '';

export const isProjectKey = (value: string) => PROJECT_KEY.test(value);

/**
 * Cleans the idea for a prompt. Line breaks stay, because a pasted list is one task per line. Other control characters go, runs of
 * spaces squeeze, and a long idea is cut with an ellipsis.
 */
export function cleanIdea(idea: string): string {
	let out = '';
	for (const ch of idea) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === '\n') out += ch;
		else if (ch === '\r') continue;
		else out += code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029 ? ' ' : ch;
	}
	out = out
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.trim();
	return out.length > IDEA_LIMIT ? `${out.slice(0, IDEA_LIMIT - 1).trimEnd()}…` : out;
}

/**
 * The fixed words in front of the idea, `/flow new KEY:` or `/flow-task KEY:`. The dialog shows them read-only inside the idea box.
 * Empty for a project key the app would not write.
 */
export function createPrefix(kind: CreateKind, key: string): string {
	if (!isProjectKey(key)) return '';
	return kind === 'plan' ? `/flow new ${key}:` : `/flow-task ${key}:`;
}

/** The prompt of the New plan and New task buttons: the fixed prefix, a space and the cleaned idea. Empty for a project key the app would not write. */
export function buildCreatePrompt(input: { kind: CreateKind; key: string; idea: string }): string {
	const prefix = createPrefix(input.kind, input.key);
	return prefix ? `${prefix} ${cleanIdea(input.idea)}` : '';
}

/** The idea a note hands over, `from note N-12`. Empty for a reference the app would not write. */
export function noteIdea(ref: string): string {
	const text = `from note ${ref.trim()}`;
	return NOTE_IDEA.test(text) ? text : '';
}

/**
 * The prompt of the Turn into a plan and Turn into tasks actions of a note: `/flow new KEY: from note N-12` and
 * `/flow-task KEY: from note N-12`. Empty for a project key or a note reference the app would not write.
 */
export function buildNotePrompt(input: { kind: CreateKind; key: string; ref: string }): string {
	const idea = noteIdea(input.ref);
	return idea ? buildCreatePrompt({ kind: input.kind, key: input.key, idea }) : '';
}
