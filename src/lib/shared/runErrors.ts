// WHAT WENT WRONG WITH A BROWSER CHECK RUN, AS A STABLE CODE AND A FIX LINE THE BOARD OWNS
// The reason of a run is text the afb-checks tool reported (already masked of secrets). It is classified here against a fixed
// list of codes, and the fix line comes from this table and never from the tool, so an agent reads board text, not tool text.

// -- TYPES -- //

export type RunErrorCode =
	| 'PREVIEW_ENV_MISSING'
	| 'PREVIEW_NEEDS_OWNER_URL'
	| 'PREVIEW_HOST_UNREACHABLE'
	| 'PREVIEW_PORT_BUSY'
	| 'DB_NOT_THROWAWAY'
	| 'TOOL_OFFLINE'
	| 'TOOL_OUTDATED'
	| 'TARGET_UNAVAILABLE'
	| 'RUN_TIMED_OUT'
	| 'SANDBOX_FAILED'
	| 'DOCKER_DOWN'
	| 'REGISTRATION_REQUIRED'
	| 'REGISTRATION_MISMATCH'
	| 'REGISTRATION_UNKNOWN';

// -- CONSTANTS -- //

/** The fix line of each code. Plain steps an agent can do, in the order to try them. */
export const RUN_FIXES: Record<RunErrorCode, string> = {
	PREVIEW_ENV_MISSING:
		'The preview started with no settings. Give the project an env file or recipe with the app address, the auth secret and the database, then run again.',
	PREVIEW_NEEDS_OWNER_URL:
		'The preview needs the database owner url for its job queue and must not seed demo data. Add the owner url of the throwaway database to the preview env and turn the demo seed off, then run again.',
	PREVIEW_HOST_UNREACHABLE:
		'The preview started but the tool could not reach it. Make the preview listen on 127.0.0.1 (preview host), then run again.',
	PREVIEW_PORT_BUSY:
		'The port the preview needs is taken. Run again; the tool picks a free port above 5200. Never free 5180 or 5190.',
	DB_NOT_THROWAWAY:
		'The tool refused this database because it may hold real data. Use the throwaway database the tool creates itself.',
	TOOL_OFFLINE:
		'No afb-checks tool is online for this project. Call runner_status and follow its agentAction on the machine that runs the tool (node afb-checks.mjs doctor --fix --json repairs it; with the bridge it is agent-flow-board check doctor --fix --json, and agent-flow-board check connect --server <url> --org <slug> --json connects a machine that never was), then ask again.',
	TOOL_OUTDATED:
		'The afb-checks tool is too old for this board. Upgrade it from a folder with a newer template (node afb-checks.mjs upgrade <that folder>), then run again.',
	TARGET_UNAVAILABLE:
		'That target cannot run now. Pick one of the targets named in the reason, or set the target up first.',
	RUN_TIMED_OUT:
		'The tool took the run and stopped reporting, or the run went on for longer than its limit (40 minutes) and the tool stopped it. Call runner_status, run node afb-checks.mjs doctor --fix --json (or agent-flow-board check doctor --fix --json with the bridge) on the machine that runs the tool, and ask again.',
	SANDBOX_FAILED:
		'The tool could not make the private copy of the repo for this run (the folder is not a git repo, is too big to copy, or the disk is full). Fix what the reason names, free disk with node afb-checks.mjs clear runs (or agent-flow-board check clear --all with the bridge), then run again.',
	DOCKER_DOWN:
		'Docker does not answer on the machine that runs the tool, so the run could not make its throwaway database. Start Docker Desktop, then run again.',
	REGISTRATION_REQUIRED:
		'This project has more than one afb-checks registration (repo folder) and the run named none. Call runner_status for the list, name one with registration on check_run or check_save, then run again.',
	REGISTRATION_MISMATCH:
		'The registration named serves a different board project. Call runner_status for the registrations of this project, name one of those, then run again.',
	REGISTRATION_UNKNOWN:
		'No afb-checks tool holds the registration named. Call runner_status for the registrations a tool holds, or register the folder (node afb-checks.mjs project <org>/<NAME> --board-project <KEY> --repo <folder> --recipe), then run again.'
};

/** The first matching line wins, so the most specific pattern comes first. */
const RULES: { code: RunErrorCode; test: RegExp }[] = [
	{ code: 'TOOL_OUTDATED', test: /too old for this board|upgrade_required|upgrade the tool/i },
	{ code: 'REGISTRATION_REQUIRED', test: /REGISTRATION_REQUIRED/ },
	{ code: 'REGISTRATION_MISMATCH', test: /REGISTRATION_MISMATCH/ },
	{
		code: 'REGISTRATION_UNKNOWN',
		test: /REGISTRATION_UNKNOWN|holds the registration|too old to run a named registration/
	},
	{
		code: 'PREVIEW_ENV_MISSING',
		test: /env_invalid|invalid environment variables|AFB_BASE_URL is required/i
	},
	{
		code: 'PREVIEW_NEEDS_OWNER_URL',
		test: /permission denied for database|violates row-level security policy for table "org"/i
	},
	{ code: 'DB_NOT_THROWAWAY', test: /port 5433, which holds real data|uses a throwaway database/i },
	{
		code: 'PREVIEW_PORT_BUSY',
		test: /EADDRINUSE|address already in use|port \d+ is already in use/i
	},
	{
		code: 'PREVIEW_HOST_UNREACHABLE',
		test: /did not answer within|ECONNREFUSED|connection refused/i
	},
	{
		code: 'RUN_TIMED_OUT',
		test: /did not report back within|stopped reporting for|took longer than \d+ minutes and was stopped/i
	},
	{ code: 'DOCKER_DOWN', test: /Docker does not answer/i },
	{
		code: 'SANDBOX_FAILED',
		test: /private copy of the repo|git clone failed|too much to copy|no space left/i
	},
	{
		code: 'TOOL_OFFLINE',
		test: /no runner (that serves|took)|tool is not connected|no check runner is connected|runner .*offline|no afb-checks tool/i
	}
];

// -- FUNCTIONS -- //

/**
 * The code and fix line for a finished run that did not pass, or nulls. A pass, a fail of the page itself and a run that is
 * still going have none: a fail is the check doing its job.
 */
export function classifyRun(
	result: string,
	reason: string | null
): { code: RunErrorCode | null; fix: string | null } {
	if (!['error', 'timeout', 'unavailable'].includes(result)) return { code: null, fix: null };
	const text = reason ?? '';
	const hit = RULES.find((r) => r.test.test(text));
	// An unavailable target with no known cause is still a target problem, never a blank
	const code: RunErrorCode | null =
		hit?.code ?? (result === 'unavailable' ? 'TARGET_UNAVAILABLE' : null);
	return { code, fix: code ? RUN_FIXES[code] : null };
}
