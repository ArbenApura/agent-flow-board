// TESTS OF THE ADOPTED .env: THE FILES AND THEIR ORDER, THE APP FOLDER WINNING, THE .env.test FALLBACK, QUOTED MULTI-LINE VALUES, ${VAR}, THE DENY LIST, THE RUN'S OWN SETTINGS, REDACTIONS

// -- DEP-MODULES -- //
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { adoptRepoEnv, isDeniedName, parseRepoEnvText } from './repoenv.js';

// -- CONSTANTS -- //

const VARS = { baseUrl: 'http://127.0.0.1:41234' };

// -- FUNCTIONS -- //

describe('adoptRepoEnv', () => {
	let repo = '';
	const put = (rel: string, text: string) => {
		const f = join(repo, rel);
		mkdirSync(join(f, '..'), { recursive: true });
		writeFileSync(f, text);
	};
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), 'afb-repoenv-'));
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it('reads the four files of the repo in order, a later file winning', () => {
		put('.env', 'A=env\nB=env\nC=env\nD=env\n');
		put('.env.local', 'B=local\n');
		put('.env.production', 'C=production\n');
		put('.env.production.local', 'D=productionlocal\n');
		const r = adoptRepoEnv({ repo }, VARS);
		expect(r.startEnv).toEqual({ A: 'env', B: 'local', C: 'production', D: 'productionlocal' });
		expect(r.files).toEqual(['.env', '.env.local', '.env.production', '.env.production.local']);
		expect(r.names).toEqual(['A', 'B', 'C', 'D']);
	});

	it('lets the app folder win over the repo root', () => {
		put('.env', 'SHARED=root\nROOT_ONLY=root\n');
		put('web/.env', 'SHARED=web\nWEB_ONLY=web\n');
		const r = adoptRepoEnv({ repo, appDir: 'web' }, VARS);
		expect(r.startEnv).toEqual({ SHARED: 'web', ROOT_ONLY: 'root', WEB_ONLY: 'web' });
		expect(r.files).toEqual(['.env', 'web/.env']);
	});

	it('accepts the app folder spelled web\\ or ./web and refuses one that leaves the repo', () => {
		put('web/.env', 'X=1\n');
		expect(adoptRepoEnv({ repo, appDir: 'web\\' }, VARS).startEnv.X).toBe('1');
		expect(adoptRepoEnv({ repo, appDir: './web' }, VARS).startEnv.X).toBe('1');
		expect(() => adoptRepoEnv({ repo, appDir: '../x' }, VARS)).toThrow(/app folder/);
		expect(() => adoptRepoEnv({ repo, appDir: '/abs' }, VARS)).toThrow(/app folder/);
	});

	it('reads .env.test only when none of the four exist in that folder', () => {
		put('.env.test', 'ONLY_TEST=1\n');
		expect(adoptRepoEnv({ repo }, VARS).startEnv).toEqual({ ONLY_TEST: '1' });
		put('.env', 'REAL=1\n');
		expect(adoptRepoEnv({ repo }, VARS).startEnv).toEqual({ REAL: '1' });
		// The fallback is decided per folder
		put('web/.env.test', 'WEB_TEST=1\n');
		expect(adoptRepoEnv({ repo, appDir: 'web' }, VARS).startEnv).toEqual({
			REAL: '1',
			WEB_TEST: '1'
		});
	});

	it('reads quoted multi-line values whole and redacts the value and each line', () => {
		put('.env', 'KEY="-----BEGIN KEY-----\nabcdefghijkl\n-----END KEY-----"\nNEXT=after\n');
		const r = adoptRepoEnv({ repo }, VARS);
		expect(r.startEnv.KEY).toBe('-----BEGIN KEY-----\nabcdefghijkl\n-----END KEY-----');
		expect(r.startEnv.NEXT).toBe('after');
		expect(r.redactions).toContain(r.startEnv.KEY);
		expect(r.redactions).toContain('abcdefghijkl');
		expect(r.redactions).not.toContain('after');
	});

	it('parses export, single quotes, inline comments, a BOM and \\n in double quotes', () => {
		const m = parseRepoEnvText(
			'﻿export A=1\nB=\'two words\'\nC=x # note\nD="a\\nb"\nE=`bt`\n# c\nnot a setting\n'
		);
		expect(m.get('A')).toBe('1');
		expect(m.get('B')).toBe('two words');
		expect(m.get('C')).toBe('x');
		expect(m.get('D')).toBe('a\nb');
		expect(m.get('E')).toBe('bt');
	});

	it('expands ${VAR} from the same files, also across the repo root and the app folder', () => {
		put('.env', 'HOSTNAME_X=db.example.com\nBASE=https://${HOSTNAME_X}\n');
		put('web/.env', 'FULL=${BASE}/api\nGONE=${NOT_SET}\nDEFAULTED=${NOT_SET:-fallback}\n');
		const r = adoptRepoEnv({ repo, appDir: 'web' }, VARS);
		expect(r.startEnv.BASE).toBe('https://db.example.com');
		expect(r.startEnv.FULL).toBe('https://db.example.com/api');
		expect(r.startEnv.GONE).toBe('');
		expect(r.startEnv.DEFAULTED).toBe('fallback');
	});

	it('keeps PORT, HOST, NODE_ENV and EMAIL_PROVIDER out: the run sets them', () => {
		put(
			'.env',
			'PORT=9999\nHOST=0.0.0.0\nNODE_ENV=development\nEMAIL_PROVIDER=postmark\nport=1\nKEEP=1\n'
		);
		expect(adoptRepoEnv({ repo }, VARS).startEnv).toEqual({ KEEP: '1' });
	});

	it('points the self-address variables at the preview, only when the value is a web address', () => {
		put(
			'.env',
			'ORIGIN=https://live.example.com\nBETTER_AUTH_URL=https://live.example.com\nPUBLIC_APP_URL=https://live.example.com\nNEXT_PUBLIC_SITE_URL=https://live.example.com\nAPP_URL=not-a-url\n'
		);
		const r = adoptRepoEnv({ repo }, VARS);
		expect(r.startEnv.ORIGIN).toBe(VARS.baseUrl);
		expect(r.startEnv.BETTER_AUTH_URL).toBe(VARS.baseUrl);
		expect(r.startEnv.PUBLIC_APP_URL).toBe(VARS.baseUrl);
		expect(r.startEnv.NEXT_PUBLIC_SITE_URL).toBe(VARS.baseUrl);
		expect(r.startEnv.APP_URL).toBe('not-a-url');
	});

	it('never adopts the deny list, in any case, and names it', () => {
		const denied = [
			'NODE_OPTIONS',
			'PATH',
			'PATHEXT',
			'COMSPEC',
			'HOME',
			'USERPROFILE',
			'APPDATA',
			'LOCALAPPDATA',
			'SYSTEMROOT',
			'TEMP',
			'TMP',
			'HTTP_PROXY',
			'HTTPS_PROXY',
			'NO_PROXY',
			'NODE_EXTRA_CA_CERTS',
			'NODE_TLS_REJECT_UNAUTHORIZED',
			'npm_config_registry',
			'NPM_CONFIG_PREFIX',
			'PNPM_HOME',
			'YARN_RC_FILENAME',
			'LD_PRELOAD',
			'ld_library_path',
			'http_proxy',
			'Path',
			'node_options'
		];
		put('.env', denied.map((k) => `${k}=value-of-${k}`).join('\n') + '\nOK_ONE=fine\n');
		const r = adoptRepoEnv({ repo }, VARS);
		expect(r.startEnv).toEqual({ OK_ONE: 'fine' });
		expect([...r.denied].sort()).toEqual([...denied].sort());
		for (const k of denied) expect(isDeniedName(k), k).toBe(true);
		expect(isDeniedName('NOT_DENIED')).toBe(false);
		expect(JSON.stringify(r.redactions)).not.toContain('value-of-');
	});

	it('redacts values of 8 or more characters and not shorter ones', () => {
		put('.env', 'LONG=12345678\nSHORT=1234567\nTOKEN=abcdefghij\n');
		const r = adoptRepoEnv({ repo }, VARS);
		expect(r.redactions.sort()).toEqual(['12345678', 'abcdefghij']);
	});

	it('does not read a link or a file over 1 MB, and an empty repo is an empty result', () => {
		put('real.txt', 'LINKED=1\n');
		try {
			symlinkSync(join(repo, 'real.txt'), join(repo, '.env'));
			expect(adoptRepoEnv({ repo }, VARS).startEnv).toEqual({});
		} catch {
			/* No right to make links here */
		}
		rmSync(join(repo, '.env'), { force: true });
		put('.env.local', 'BIG=' + 'x'.repeat(1_100_000));
		expect(adoptRepoEnv({ repo }, VARS).names).toEqual([]);
		const empty = mkdtempSync(join(tmpdir(), 'afb-repoenv-empty-'));
		try {
			expect(adoptRepoEnv({ repo: empty }, VARS)).toEqual({
				startEnv: {},
				redactions: [],
				names: [],
				denied: [],
				files: []
			});
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it('reads the files of the source repo only: a copy path is simply another folder', () => {
		put('.env', 'A=1\n');
		const other = mkdtempSync(join(tmpdir(), 'afb-repoenv-copy-'));
		try {
			expect(adoptRepoEnv({ repo: other }, VARS).names).toEqual([]);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});
