// CONTINUE WITH A CODING TOOL: THE PROMPT, THE COMMAND AND THE LINK THAT HAND AN ITEM TO CLAUDE CODE, CODEX OR GEMINI CLI (FLOW-20261017-0916)
// Free text (the item title, anything typed) is never put into a shell command. The command is built from controlled text only.

// -- MODULES -- //
import { isItemRef } from './ref';

// -- TYPES -- //

export type ContinueToolId = 'claude-code' | 'codex' | 'gemini' | 'other';
export type ContinueMode = 'vscode' | 'command' | 'prompt';
export type ContinueAction = 'resume' | 'ask' | 'audit' | 'critic' | 'interview';
export type ContinueTool = {
	id: ContinueToolId;
	label: string;
	/** The program and its flag that start a session with a prompt, or null when there is no command to copy. */
	command: string | null;
	/** True when the tool has a link that opens a chat with the prompt typed in. */
	vscode: boolean;
};

// -- CONSTANTS -- //

export const CONTINUE_TOOLS: readonly ContinueTool[] = [
	{ id: 'claude-code', label: 'Claude Code', command: 'claude', vscode: true },
	{ id: 'codex', label: 'Codex', command: 'codex', vscode: false },
	{ id: 'gemini', label: 'Gemini CLI', command: 'gemini -i', vscode: false },
	{ id: 'other', label: 'Other', command: null, vscode: false }
];
export const CONTINUE_TOOL_IDS = ['claude-code', 'codex', 'gemini', 'other'] as const;
export const CONTINUE_MODES = ['vscode', 'command', 'prompt'] as const;
export const CONTINUE_MODE_LABEL: Record<ContinueMode, string> = {
	vscode: 'Open in VS Code',
	command: 'Copy command',
	prompt: 'Copy prompt'
};
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
	critic: 'Critic',
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
/** The workflow each action runs. AFB serves these four as MCP prompts and through the workflow_get tool. */
const WORKFLOW: Record<ContinueAction, string> = {
	resume: 'flow',
	ask: 'flow',
	audit: 'flow-audit',
	critic: 'flow-critic',
	interview: 'flow-interview'
};
/** The name a tool is connected under, from the Connect a tool page. Claude Code shows its MCP prompts as /mcp__<name>__<prompt>. */
const SERVER = 'agent-flow-board';
export const DEFAULT_TOOL: ContinueToolId = 'claude-code';
export const DEFAULT_MODE: ContinueMode = 'vscode';

/** The longest title the prompt carries. */
export const TITLE_LIMIT = 200;
/** The longest link a chat link may be. Longer ones are not opened, the person copies the prompt instead. */
export const LINK_LIMIT = 4000;
/** The only characters a shell command may carry. Nothing in this set is special in PowerShell, cmd, bash or zsh. */
const SAFE_COMMAND_TEXT = /^[A-Za-z0-9 .,:\-_/]+$/;

// -- FUNCTIONS -- //

export const parseTool = (value: unknown): ContinueToolId =>
	(CONTINUE_TOOL_IDS as readonly unknown[]).includes(value)
		? (value as ContinueToolId)
		: DEFAULT_TOOL;

export const parseMode = (value: unknown): ContinueMode =>
	(CONTINUE_MODES as readonly unknown[]).includes(value) ? (value as ContinueMode) : DEFAULT_MODE;

export const toolOf = (id: ContinueToolId): ContinueTool =>
	CONTINUE_TOOLS.find((t) => t.id === id) ?? CONTINUE_TOOLS[0];

/** Open in VS Code is only for a tool that has the link. Every other pair is allowed. */
export const validPair = (tool: ContinueToolId, mode: ContinueMode) =>
	mode !== 'vscode' || toolOf(tool).vscode;

/** The way that really runs for a saved pair: a way the tool cannot do falls back to the next best one. */
export function effectiveMode(tool: ContinueToolId, mode: ContinueMode): ContinueMode {
	const t = toolOf(tool);
	if (mode === 'vscode' && !t.vscode) return t.command ? 'command' : 'prompt';
	if (mode === 'command' && !t.command) return 'prompt';
	return mode;
}

/** An item reference as the app writes it: the stamp form (HAPR-20261017-0950) or the old number form (HAPR-2), nothing else. */
export const isRef = isItemRef;

/** Removes control characters and line breaks, squeezes spaces and cuts a long title with an ellipsis. */
export function cleanTitle(title: string): string {
	let out = '';
	for (const ch of title) {
		const code = ch.codePointAt(0) ?? 0;
		const control = code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
		out += control ? ' ' : ch;
	}
	out = out.replace(/ {2,}/g, ' ').trim();
	return out.length > TITLE_LIMIT ? `${out.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : out;
}

/**
 * The slash command of the /flow skills, the same shape the HAPR Board writes: `/flow resume REF`, `/flow-audit REF`, `/flow-critic REF`,
 * `/flow-interview REF` and `/flow REF: ` for a question. Claude Code has the skills installed beside the agent-flow-board connection.
 * Null for a reference the app would not write.
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

/** The same request in plain words, for a tool that has no MCP prompts. It names the workflow, so the tool reads and follows it. */
function plainPrompt(action: ContinueAction, ref: string): string {
	const workflow = WORKFLOW[action];
	const start = `Use the ${SERVER} connection: call session_start, then work_start for ${ref}, read the workflow with workflow_get ${workflow}`;
	switch (action) {
		case 'resume':
			return `Continue ${ref} in ${SERVER} with its flow workflow. ${start}, take the next open step, build it and record each finished step with step_done.`;
		case 'ask':
			return `Use the ${SERVER} flow workflow, workflow_get flow, for ${ref}: `;
		case 'audit':
			return `Audit ${ref} in ${SERVER} with its flow-audit workflow. ${start} and follow it, so the record matches what was built.`;
		case 'critic':
			return `Review ${ref} in ${SERVER} with its flow-critic workflow. ${start} and follow it.`;
		case 'interview':
			return `Interview me about ${ref} in ${SERVER} with its flow-interview workflow. ${start} and follow it.`;
	}
}

/** True when Claude Code can run the action as its own slash command. Ask is one too: the person finishes it after the colon. */
export const usesSlash = (tool: ContinueToolId, _action: ContinueAction) => tool === 'claude-code';

/**
 * The full prompt, for copying or typing into a chat. For Claude Code it is the workflow's slash command. For any other tool, and for Ask,
 * it is plain words that name the workflow, plus the title and the address. It carries the title, so it never goes into a shell command.
 */
export function buildPrompt(input: {
	action: ContinueAction;
	tool: ContinueToolId;
	ref: string;
	title: string;
	url: string;
}): string {
	const { action, tool, ref, url } = input;
	const slash = usesSlash(tool, action) ? slashCommand(action, ref) : null;
	if (slash) return slash;
	const title = cleanTitle(input.title);
	if (action === 'ask') return plainPrompt(action, ref);
	return `${plainPrompt(action, ref)}${title ? ` Item: ${title}.` : ''} Address: ${url}`;
}

/** The text a command carries: controlled text only, no title and no address. Null for a reference the app would not write. */
export function commandPrompt(
	action: ContinueAction,
	tool: ContinueToolId,
	ref: string
): string | null {
	if (!isRef(ref)) return null;
	return (usesSlash(tool, action) ? slashCommand(action, ref) : null) ?? plainPrompt(action, ref);
}

/** True when every character is one a shell treats as plain text. */
export const isSafeCommandText = (text: string) => SAFE_COMMAND_TEXT.test(text);

/** One line that starts the tool with the text. Null when the tool has no command or the text has a special character. */
export function buildCommand(tool: ContinueToolId, text: string): string | null {
	const command = toolOf(tool).command;
	const body = text.trim();
	// A leading dash would read as a flag of the tool, not as the prompt
	if (!command || !isSafeCommandText(body) || body.startsWith('-')) return null;
	return `${command} "${body}"`;
}

/** The link that opens a chat in VS Code with the prompt typed in, not sent. Null when it would be too long. */
export function vscodeLink(prompt: string): string | null {
	const link = `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`;
	return link.length > LINK_LIMIT ? null : link;
}
