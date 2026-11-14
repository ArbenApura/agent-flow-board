// TESTS FOR WINDOWS CRLF / GIT BASH ENVIRONMENT CHECKS IN DOCTOR (STEP E.2, AFB-20261113-1008)

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { checkWindowsEnvironment, hasCrlfLineEndings } from './windowsEnv.js';

// -- TESTS -- //

describe('windowsEnv / check doctor Windows diagnostics (E.2)', () => {
	it('detects CRLF line endings cleanly', () => {
		expect(hasCrlfLineEndings('a\r\nb')).toBe(true);
		expect(hasCrlfLineEndings('a\nb')).toBe(false);
	});

	it('emits Git Bash and CRLF notes on Windows when core.autocrlf=true without .gitattributes', () => {
		const res = checkWindowsEnvironment('C:\\repo', {
			platform: 'win32',
			hasGitDir: () => true,
			gitAutocrlf: () => 'true',
			hasGitattributes: () => false
		});
		expect(res.problems).toEqual([]);
		expect(res.autocrlf).toBe('true');
		expect(res.gitattributesPresent).toBe(false);
		expect(res.notes.some((n) => n.includes('MSYS_NO_PATHCONV=1'))).toBe(true);
		expect(res.notes.some((n) => n.includes('core.autocrlf is true'))).toBe(true);
	});

	it('stays silent on CRLF warning when .gitattributes normalizes line endings or on Linux', () => {
		const winWithAttr = checkWindowsEnvironment('C:\\repo', {
			platform: 'win32',
			hasGitDir: () => true,
			gitAutocrlf: () => 'true',
			hasGitattributes: () => true
		});
		expect(winWithAttr.notes.some((n) => n.includes('core.autocrlf'))).toBe(false);
		expect(winWithAttr.notes.some((n) => n.includes('MSYS_NO_PATHCONV=1'))).toBe(true);

		const linux = checkWindowsEnvironment('/repo', {
			platform: 'linux',
			hasGitDir: () => true,
			gitAutocrlf: () => 'false',
			hasGitattributes: () => false
		});
		expect(linux.notes).toEqual([]);
	});
});
