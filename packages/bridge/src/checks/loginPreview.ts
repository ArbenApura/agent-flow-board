// THE SITE A LOGIN HAPPENS ON FOR A REPO REGISTRATION: ITS OWN PREVIEW
// A repo registration has no address of its own: its app is built and started from the repo, on a free port, with the registration's sealed test project and mail fence,
// exactly as a run does it. The owner signs in on that preview once; the sign-in is bound to the loopback and the sealed project, not to the port, so every later run finds it.
// The preview is stopped by the login's own scope when the login ends, whatever ends it.

// -- TYPES -- //
import type { Registration } from './types.js';
import type { LoginTarget } from './login.js';
// -- MODULES -- //
import { ensureBrowser } from './browser.js';
import { startPreview } from './preview.js';
import { configFor, pinState } from './registry.js';
import { newRunId, RunScope } from './scope.js';
import { sealedKey } from './signinChoice.js';

// -- FUNCTIONS -- //

/**
 * The login target of a repo registration: the preview of its own folder. A recipe that makes a throwaway database is not started at all (the target says so and the login
 * refuses). The files that decide what runs must be the approved ones, as for a board run.
 */
export async function repoLoginTarget(
	registration: Registration,
	say: (line: string) => void
): Promise<LoginTarget> {
	const cfg = configFor(registration);
	if (cfg.needsDatabase)
		return {
			baseUrl: 'http://127.0.0.1',
			throwawayDatabase: true,
			stop: async () => undefined
		};
	if (pinState(registration) !== 'ok')
		throw new Error(
			`The files that decide what runs in ${registration.name} changed since they were approved. Approve them again: agent-flow-board check project pin ${registration.name} --org ${registration.org}`
		);
	await ensureBrowser(say);
	const runId = newRunId();
	const scope = new RunScope(runId, say);
	scope.start();
	try {
		const preview = await startPreview(cfg, { runId, scope, log: say });
		return {
			baseUrl: preview.baseUrl,
			testUser: preview.testUser,
			hosts: preview.extraHosts ?? [],
			restrictHosts: true,
			sealedHost: sealedKey(preview.extraHosts),
			throwawayDatabase: preview.throwawayDatabase === true,
			mail: preview.mail ? { inbox: preview.mail.inbox } : null,
			stop: () => scope.close()
		};
	} catch (e) {
		await scope.close();
		throw e;
	}
}
