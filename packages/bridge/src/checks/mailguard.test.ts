// TESTS OF THE MAIL GUARD: THE HOOK RUN IN A REAL CHILD PROCESS (REWRITE, REFUSE, COUNT, LISTENING) AND THE TOOL SIDE (NODE_OPTIONS ORDER, FAIL CLOSED OVER THE MAIL SET)

// -- DEP-MODULES -- //
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	enforceMailSet,
	fenceProblem,
	mailSetNames,
	readFence,
	withMailGuard
} from './mailguard.js';

// -- CONSTANTS -- //

const HERE = dirname(fileURLToPath(import.meta.url));
const INBOX = 'inbox@example.com';
const fwd = (p: string) => p.replace(/\\/g, '/');
const STUB = `
const fs = require('node:fs');
globalThis.fetch = async (u, init) => {
  fs.appendFileSync(process.env.STUB_OUT, JSON.stringify({ url: String(u), method: init && init.method, body: init && init.body }) + '\\n');
  return new Response('{"ok":true}', { status: 200 });
};`;
const MAIN = `
const http = require('node:http');
const net = require('node:net');
const call = async (url, init) => { const r = await fetch(url, init); return r.status; };
(async () => {
  const out = {};
  const post = (body) => ({ method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  out.single = await call('https://api.postmarkapp.com/email', post({ From: 'a@x.com', To: 'victim@real.org', Cc: 'c@real.org', Subject: 'Hi' }));
  out.batch = await call('https://api.postmarkapp.com/email/batch', post([{ To: 'one@real.org' }, { To: 'two@real.org' }]));
  out.already = await call('https://api.postmarkapp.com/email', post({ To: '${INBOX}' }));
  out.notJson = await call('https://api.postmarkapp.com/email', post('not json'));
  out.noRecipient = await call('https://api.postmarkapp.com/email', post({ Subject: 'x' }));
  out.spelled = await call('https://api.postmarkapp.com/email', post({ to: 'a@real.org' }));
  out.badPath = await call('https://api.postmarkapp.com/servers', post({ To: 'a@real.org' }));
  out.get = await call('https://api.postmarkapp.com/server', { method: 'GET' });
  out.other = await call('https://example.com/email', post({ To: 'a@real.org' }));
  out.badUrl = await call('http://[::bad', post({}));
  try { http.request('https://api.postmarkapp.com/email'); out.direct = 'allowed'; } catch { out.direct = 'refused'; }
  const srv = net.createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  out.port = srv.address().port; srv.close();
  console.log(JSON.stringify(out));
})();`;

// -- FUNCTIONS -- //

describe('mail guard hook in a child process', () => {
	let dir = '';
	let hook = '';
	let stub = '';
	let main = '';
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'afb-mail-'));
		const src = readFileSync(join(HERE, 'mailguard-hook.cts'), 'utf8');
		hook = join(dir, 'mailguard-hook.cjs');
		writeFileSync(
			hook,
			ts.transpileModule(src, {
				compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
			}).outputText
		);
		stub = join(dir, 'stub.cjs');
		writeFileSync(stub, STUB);
		main = join(dir, 'main.cjs');
		writeFileSync(main, MAIN);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function run(inbox: string | null) {
		const out = join(dir, `out-${Math.random().toString(36).slice(2)}.jsonl`);
		const log = join(dir, `fence-${Math.random().toString(36).slice(2)}.jsonl`);
		const base: Record<string, string> = {
			PATH: process.env.PATH ?? '',
			SYSTEMROOT: process.env.SYSTEMROOT ?? '',
			STUB_OUT: out,
			NODE_OPTIONS: `--require "${fwd(stub)}"`
		};
		const env =
			inbox === null
				? {
						...base,
						NODE_OPTIONS: `${base.NODE_OPTIONS} --require "${fwd(hook)}"`,
						AFB_MAIL_FENCE_LOG: log
					}
				: withMailGuard(base, { inbox, log, hookFile: hook });
		const r = spawnSync(process.execPath, [main], { env, encoding: 'utf8', timeout: 30_000 });
		expect(r.status).toBe(0);
		const result = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
		let sent: { url: string; body?: string }[];
		try {
			sent = readFileSync(out, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as { url: string; body?: string });
		} catch {
			sent = [];
		}
		return { result, sent, log, stderr: r.stderr };
	}

	it('rewrites every recipient to the one inbox, drops Cc and Bcc, refuses what it cannot read, and counts', () => {
		const { result, sent, log, stderr } = run(INBOX);
		expect(result.single).toBe(200);
		expect(result.batch).toBe(200);
		expect(result.already).toBe(200);
		for (const k of ['notJson', 'noRecipient', 'spelled', 'badPath', 'badUrl'])
			expect(result[k]).toBe(422);
		expect(result.get).toBe(200);
		expect(result.other).toBe(200);
		expect(result.direct).toBe('refused');
		const postmark = sent.filter((s) => s.url.includes('postmarkapp.com'));
		const single = JSON.parse(postmark[0]?.body ?? '{}') as Record<string, string>;
		expect(single.To).toBe(INBOX);
		expect(single.Cc).toBeUndefined();
		expect(single.Subject).toContain('would go to v***@real.org, c***@real.org');
		const batch = JSON.parse(postmark[1]?.body ?? '[]') as { To: string }[];
		expect(batch.map((m) => m.To)).toEqual([INBOX, INBOX]);
		// Nothing sent to a real recipient reached the (stubbed) network
		expect(postmark.map((p) => p.body).join('')).not.toContain('victim@real.org');
		// The other host went through untouched
		expect(sent.find((s) => s.url.startsWith('https://example.com'))?.body).toContain('a@real.org');
		const fence = readFence(log, Number(result.port));
		expect(fence.loaded).toBe(true);
		expect(fence.sends).toBe(4);
		expect(fence.rewritten).toBe(3);
		expect(fence.refused).toBeGreaterThanOrEqual(6);
		// The log never carries a full address
		expect(readFileSync(log, 'utf8')).not.toContain('victim@real.org');
		expect(stderr).not.toContain('victim@real.org');
		// A port that is not the one the app listened on does not count as loaded
		expect(readFence(log, Number(result.port) + 1).loaded).toBe(false);
	});

	it('refuses every send when it was given no inbox', () => {
		const { result, sent } = run(null);
		expect(result.single).toBe(422);
		expect(result.already).toBe(422);
		expect(
			sent.filter((s) => s.url.includes('postmarkapp.com') && s.url.endsWith('/email'))
		).toEqual([]);
	});
});

describe('withMailGuard', () => {
	it('appends the hook to NODE_OPTIONS last, folds another spelling, sets the fence variables', () => {
		const r = withMailGuard(
			{ A: '1', Node_Options: '--require "/x/y.cjs"' },
			{ inbox: INBOX, log: '/tmp/fence.log', hookFile: 'C:\\h\\mailguard-hook.cjs' }
		);
		expect(r.NODE_OPTIONS).toBe('--require "/x/y.cjs" --require "C:/h/mailguard-hook.cjs"');
		expect(Object.keys(r).filter((k) => k.toUpperCase() === 'NODE_OPTIONS')).toEqual([
			'NODE_OPTIONS'
		]);
		expect(r.AFB_MAIL_FENCE_INBOX).toBe(INBOX);
		expect(r.AFB_MAIL_FENCE_LOG).toBe('/tmp/fence.log');
		expect(r.A).toBe('1');
	});
	it('sets NODE_OPTIONS alone when there was none, and refuses a bad inbox or no log', () => {
		const r = withMailGuard({}, { inbox: INBOX, log: 'l', hookFile: '/h/hook.cjs' });
		expect(r.NODE_OPTIONS).toBe('--require "/h/hook.cjs"');
		expect(() => withMailGuard({}, { inbox: 'nope', log: 'l' })).toThrow(/test inbox/);
		expect(() => withMailGuard({}, { inbox: INBOX, log: '' })).toThrow(/log file/);
	});
	it('points at mailguard-hook.cjs next to the module by default', () => {
		const r = withMailGuard({}, { inbox: INBOX, log: 'l' });
		expect(r.NODE_OPTIONS).toMatch(/mailguard-hook\.cjs"$/);
	});
});

describe('the mail set fails closed', () => {
	const env = {
		POSTMARK_SERVER_TOKEN: 'a',
		SMTP_HOST: 'b',
		SENDGRID_API_KEY: 'c',
		MAILGUN_KEY: 'd',
		RESEND_API_KEY: 'e',
		AWS_SES_REGION: 'f',
		SES_KEY: 'g',
		EMAIL_FROM: 'h',
		MAIL_URL: 'i',
		EMAIL_PROVIDER: 'log',
		SESSION_SECRET: 'keep',
		PUBLIC_TITLE: 'keep'
	};
	it('names the whole set and not the run own EMAIL_PROVIDER or SESSION_SECRET', () => {
		expect(mailSetNames(env).sort()).toEqual(
			[
				'AWS_SES_REGION',
				'EMAIL_FROM',
				'MAIL_URL',
				'MAILGUN_KEY',
				'POSTMARK_SERVER_TOKEN',
				'RESEND_API_KEY',
				'SENDGRID_API_KEY',
				'SES_KEY',
				'SMTP_HOST'
			].sort()
		);
	});
	it('strips every mail setting that was not sealed and keeps the sealed one', () => {
		const r = enforceMailSet(env, ['POSTMARK_SERVER_TOKEN']);
		expect(r.env.POSTMARK_SERVER_TOKEN).toBe('a');
		expect(r.env.SMTP_HOST).toBeUndefined();
		expect(r.env.SES_KEY).toBeUndefined();
		expect(r.env.SESSION_SECRET).toBe('keep');
		expect(r.env.EMAIL_PROVIDER).toBe('log');
		expect(r.stripped).toHaveLength(8);
		expect(r.problems).toEqual([]);
	});
	it('in refuse mode lists names, never values', () => {
		const r = enforceMailSet({ POSTMARK_SERVER_TOKEN: 'secret-token-value' }, [], 'refuse');
		expect(r.problems).toHaveLength(1);
		expect(r.problems[0]).toContain('POSTMARK_SERVER_TOKEN');
		expect(r.problems.join(' ')).not.toContain('secret-token-value');
	});
	it('a run with sealed mail does not count unless the guard reported listening', () => {
		const none = { loaded: false, sends: 0, rewritten: 0, refused: 0 };
		expect(fenceProblem(true, none)).toMatch(/did not report listening/);
		expect(fenceProblem(true, { ...none, loaded: true })).toBeNull();
		expect(fenceProblem(false, none)).toBeNull();
	});
	it('readFence of a missing log is empty', () => {
		expect(readFence(join(tmpdir(), 'afb-no-such-fence.log'), 1).loaded).toBe(false);
		expect(readFence(undefined)).toEqual({ loaded: false, sends: 0, rewritten: 0, refused: 0 });
	});
});
