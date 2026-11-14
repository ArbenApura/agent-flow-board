// THE STATUS FILE OF A CONVERSATION (AFB-20261108-0427, S.2): WHEN THE BRIDGE ASKS FOR THE STATUS, WHAT IT WRITES, REPLACES, REMOVES AND PURGES
// Each rule has a negative control, so a test cannot pass on a bridge that does nothing.

// IMPORTED DEP-MODULES
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { antigravity, claude, gemini } from './hooks/adapters.js';
import type { HookEvent } from './hooks/call.js';
import { PURGE_AFTER_MS, applyStatusFile, statusName } from './hooks/statusFile.js';

// -- CONSTANTS -- //

const ID = 'claude-session-0001';
const STATUS = { sessionId: 's_x', tool: 'claude-code', externalId: ID, etag: 'e1', item: null };

// -- FUNCTIONS -- //

const event = (over: Partial<HookEvent> = {}): HookEvent => ({
	tool: 'claude-code',
	event: 'prompt',
	externalId: ID,
	status: true,
	...over
});

describe('which hook events ask for the status', () => {
	const claudeEvent = (payload: Record<string, unknown>) =>
		claude.toEvent('', { session_id: ID, ...payload });

	it('asks on the start, a prompt, the stop and a call of the board tools', () => {
		expect(claudeEvent({ hook_event_name: 'SessionStart' })?.status).toBe(true);
		expect(claudeEvent({ hook_event_name: 'UserPromptSubmit' })?.status).toBe(true);
		expect(claudeEvent({ hook_event_name: 'Stop' })?.status).toBe(true);
		expect(
			claudeEvent({
				hook_event_name: 'PostToolUse',
				tool_name: 'mcp__afb-arbenger__step_done',
				tool_input: {}
			})?.status
		).toBe(true);
	});

	it('does not ask on plain edits, reads, a shell, the end, or for another tool', () => {
		for (const tool_name of ['Edit', 'Read', 'Bash'])
			expect(
				claudeEvent({ hook_event_name: 'PostToolUse', tool_name, tool_input: {} })?.status
			).toBeUndefined();
		expect(claudeEvent({ hook_event_name: 'SessionEnd' })?.status).toBeUndefined();
		expect(
			gemini.toEvent('', { session_id: ID, hook_event_name: 'SessionStart' })?.status
		).toBeUndefined();
		expect(
			antigravity.toEvent('PreInvocation', { conversationId: 'conv-0001-abcd', invocationNum: 0 })
				?.status
		).toBeUndefined();
	});
});

describe('the status file', () => {
	let root: string;
	let dir: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'afb-status-'));
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const fresh = () => {
		dir = mkdtempSync(join(root, 'case-'));
		return dir;
	};
	const file = (name = ID) => join(dir, `${name}.json`);
	const read = () => JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;

	it('writes the status with its times, and nothing else of the answer', () => {
		fresh();
		applyStatusFile(
			dir,
			event(),
			{ status: STATUS, context: 'a brief', nudge: 'a nudge', title: 'T' },
			1000,
			2000
		);
		const written = read();
		expect(written).toEqual({ v: 1, asOf: 1000, writtenAt: 2000, status: STATUS });
		// Negative control: the brief, the nudge and the title stay out of the file
		expect(readFileSync(file(), 'utf8')).not.toMatch(/brief|nudge/);
		// No leftover of the temporary file
		expect(readdirSync(dir)).toEqual([`${ID}.json`]);
	});

	it('does nothing without the flag, and nothing when the answer has no status', () => {
		fresh();
		applyStatusFile(dir, event({ status: undefined }), { status: STATUS }, 1, 2);
		expect(existsSync(file())).toBe(false);
		applyStatusFile(dir, event(), {}, 1, 2);
		applyStatusFile(dir, event(), null, 1, 2);
		expect(existsSync(file())).toBe(false);
	});

	it('replaces a file with a newer answer, and keeps a newer file against an older answer', () => {
		fresh();
		applyStatusFile(dir, event(), { status: { ...STATUS, etag: 'first' } }, 1000, 2000);
		applyStatusFile(dir, event(), { status: { ...STATUS, etag: 'second' } }, 3000, 4000);
		expect((read().status as { etag: string }).etag).toBe('second');
		// An answer to an older request that came back late must not win
		applyStatusFile(dir, event(), { status: { ...STATUS, etag: 'late' } }, 2000, 5000);
		expect((read().status as { etag: string }).etag).toBe('second');
	});

	it('removes the file at the end, and a late hook of the same conversation cannot write it again', () => {
		fresh();
		applyStatusFile(dir, event(), { status: STATUS }, 1, 2);
		expect(existsSync(file())).toBe(true);
		applyStatusFile(dir, event({ event: 'end', status: undefined }), null, 3, 4);
		expect(existsSync(file())).toBe(false);
		applyStatusFile(dir, event(), { status: STATUS }, 5, 6);
		expect(existsSync(file())).toBe(false);
		// A resumed conversation starts again: the marker goes and the file may be written
		applyStatusFile(dir, event({ event: 'start' }), { status: STATUS }, 7, 8);
		expect(existsSync(file())).toBe(true);
	});

	it('removes the file when a board call got no answer, and keeps it for a call that cannot change the claim', () => {
		fresh();
		applyStatusFile(dir, event(), { status: STATUS }, 1, 2);
		applyStatusFile(dir, event({ event: 'prompt' }), null, 3, 4);
		expect(existsSync(file())).toBe(true);
		applyStatusFile(
			dir,
			event({ event: 'tool', action: { kind: 'board', name: 'work_stop' } }),
			null,
			5,
			6
		);
		expect(existsSync(file())).toBe(false);
	});

	it('purges what is older than two days when a conversation starts, and keeps what is newer', () => {
		fresh();
		const old = join(dir, 'old-conversation-1.json');
		const young = join(dir, 'young-conversation-1.json');
		const leftover = join(dir, 'old-conversation-1.123.tmp');
		for (const f of [old, young, leftover]) writeFileSync(f, '{}');
		const longAgo = new Date(Date.now() - PURGE_AFTER_MS - 60_000);
		for (const f of [old, leftover]) utimesSync(f, longAgo, longAgo);
		applyStatusFile(dir, event({ event: 'start', status: undefined }), null, 1, Date.now());
		expect(existsSync(old)).toBe(false);
		expect(existsSync(leftover)).toBe(false);
		expect(existsSync(young)).toBe(true);
		// Negative control: a prompt does not purge
		writeFileSync(old, '{}');
		utimesSync(old, longAgo, longAgo);
		applyStatusFile(dir, event({ event: 'prompt', status: undefined }), null, 2, Date.now());
		expect(existsSync(old)).toBe(true);
	});

	it('writes nothing for an id that is not a plain name', () => {
		fresh();
		for (const bad of ['../escape-0001', 'a/b-0000001', '.hidden-0001', 'x', 'bad name 0001'])
			expect(statusName(bad)).toBeNull();
		applyStatusFile(dir, event({ externalId: '../escape-0001' }), { status: STATUS }, 1, 2);
		expect(readdirSync(dir)).toEqual([]);
		expect(existsSync(join(dir, '..', 'escape-0001.json'))).toBe(false);
		expect(statusName(ID)).toBe(ID);
	});

	it('never throws when the folder cannot be made', () => {
		fresh();
		// A plain file stands where the folder should be
		const blocked = join(dir, 'blocked');
		writeFileSync(blocked, 'not a folder');
		expect(() => applyStatusFile(blocked, event(), { status: STATUS }, 1, 2)).not.toThrow();
		expect(() => applyStatusFile(blocked, event({ event: 'end' }), null, 1, 2)).not.toThrow();
		expect(statSync(blocked).isFile()).toBe(true);
	});

	it.skipIf(process.platform === 'win32')('is readable only by its owner', () => {
		fresh();
		applyStatusFile(dir, event(), { status: STATUS }, 1, 2);
		expect(statSync(file()).mode & 0o077).toBe(0);
	});
});
